"""Horatio user tap — records *human* actions in Blender to the Horatio store.

Companion to the MCP tap: the tap records agent traffic on the wire; this addon
records what the user does by hand in the UI, so distilled memory can see both
halves of a collaborative session.

Design (mirrors Horatio invariants):
- Events attach to the BLEND, not a session: `blends/<id>/user.jsonl`.
  Sessions are tap-scoped; hand edits have no tap, and two live sessions on one
  blend would make session attribution ambiguous. The blend bucket is where
  durable memory already lives.
- `user.jsonl` has ONE writer: this addon. It never touches raw.jsonl,
  meta.json, or anything the JS side owns.
- Logging must never break Blender: every handler is fully try/except'd.
- No speculation: records are verbatim operator names / object deltas.
- Agent-driven changes are DROPPED, not logged: the MCP tap already records
  them precisely. We detect them by wrapping blender-mcp's command executor.

Capture sources:
- Operator history (`wm.operators`) polled ~1s — semantic actions
  ("transform.translate", "mesh.primitive_cube_add"), pointer-tracked so
  history rotation doesn't double-count.
- `depsgraph_update_post` — object-level transform/geometry flags, debounced
  to one record per quiet gap.

Unsaved files are not recorded (no blend id to attach to).
"""

bl_info = {
    "name": "Horatio User Tap",
    "author": "Horatio",
    "version": (0, 1, 0),
    "blender": (4, 0, 0),
    "location": "Background (no UI)",
    "description": "Records user actions to the Horatio flight-recorder store",
    "category": "System",
}

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import bpy
from bpy.app.handlers import persistent

# --------------------------------------------------------------------------
# Store resolution — mirrors src/lib/store.ts homeDir()
# --------------------------------------------------------------------------

def _store_home() -> str:
    env = os.environ.get("HORATIO_HOME") or os.environ.get("FLIGHTREC_HOME")
    if env:
        return os.path.expanduser(env)
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Horatio")
    if os.name == "nt":
        return os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Horatio")
    xdg = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(xdg, "horatio")


def _blend_id(blend_path: str) -> str:
    """EXACT mirror of blendIdForPath() in src/lib/blend-link.ts."""
    abs_path = os.path.abspath(os.path.expanduser(blend_path))
    base = os.path.splitext(os.path.basename(abs_path))[0] or "blend"
    safe = re.sub(r"[/\\]", "-", base)
    # JS \w is ASCII; re.ASCII keeps the two implementations byte-identical.
    safe = re.sub(r"[^\w.\- +()\[\]]+", "-", safe, flags=re.ASCII).strip() or "blend"
    h = hashlib.sha256(abs_path.encode("utf-8")).hexdigest()[:8]
    return f"{safe}-{h}"


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

class _State:
    user_jsonl: str | None = None      # target file for the open blend
    op_pointers: set[int] = set()      # wm.operators entries already logged
    agent_op_pointers: set[int] = set()  # entries attributed to the MCP agent
    agent_depth: int = 0               # >0 while blender-mcp executes a command
    last_agent_time: float = 0.0       # depsgraph events land AFTER the command
    agent_hooked: bool = False
    pending_deltas: dict = {}          # name -> {"transform": bool, "geometry": bool}
    last_delta_time: float = 0.0
    started_logged: bool = False


S = _State()
_DELTA_QUIET_S = 1.5
# Depsgraph updates caused by an agent command evaluate on the NEXT main-loop
# pass, after execute_command returned. Anything this close to agent activity
# is treated as agent-caused — dropping a rare user edit beats mislabeling.
_AGENT_GRACE_S = 1.0
_MAX_DELTA_OBJECTS = 8
_MAX_PROP_CHARS = 120


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def _retarget() -> None:
    """Recompute the output file for the currently open blend (None if unsaved)."""
    fp = bpy.data.filepath
    if not fp:
        S.user_jsonl = None
        return
    bucket = os.path.join(_store_home(), "blends", _blend_id(fp))
    os.makedirs(bucket, exist_ok=True)
    S.user_jsonl = os.path.join(bucket, "user.jsonl")


def _append(rec: dict) -> None:
    if not S.user_jsonl:
        return
    try:
        with open(S.user_jsonl, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass  # logging must never break Blender


# --------------------------------------------------------------------------
# Agent discrimination — wrap blender-mcp's executor so its side effects
# (which the tap already records) are not double-logged as user actions.
# --------------------------------------------------------------------------

def _hook_agent_executor() -> None:
    if S.agent_hooked:
        return
    for name, mod in list(sys.modules.items()):
        if name.startswith("bpy"):
            continue  # bpy.ops fabricates ANY attribute — phantom match
        cls = getattr(mod, "BlenderMCPServer", None)
        # must be a real class with a real function, not an operator accessor
        if not isinstance(cls, type) or not callable(getattr(cls, "execute_command", None)):
            continue
        if getattr(cls, "_horatio_wrapped", False):
            S.agent_hooked = True
            return
        orig = cls.execute_command

        def wrapped(self, *args, _orig=orig, **kwargs):
            S.agent_depth += 1
            try:
                return _orig(self, *args, **kwargs)
            finally:
                S.agent_depth -= 1
                S.last_agent_time = time.monotonic()
                try:
                    # Anything now in operator history was (or predates) agent
                    # work — never attribute it to the user.
                    wm = bpy.context.window_manager
                    for op in wm.operators:
                        S.agent_op_pointers.add(op.as_pointer())
                    if len(S.agent_op_pointers) > 512:
                        S.agent_op_pointers.clear()
                except Exception:
                    pass

        cls.execute_command = wrapped
        cls._horatio_wrapped = True
        S.agent_hooked = True
        return


# --------------------------------------------------------------------------
# Capture: operator history
# --------------------------------------------------------------------------

def _op_props(op) -> dict:
    out = {}
    try:
        for k in op.properties.keys():
            try:
                v = getattr(op.properties, k)
                if isinstance(v, (int, float, bool, str)):
                    out[k] = round(v, 4) if isinstance(v, float) else v
                elif hasattr(v, "__len__") and len(v) <= 4:
                    out[k] = [round(float(x), 4) for x in v]
            except Exception:
                continue
            if len(json.dumps(out)) > _MAX_PROP_CHARS:
                out.pop(k, None)
                break
    except Exception:
        pass
    return out


def _poll_operators() -> None:
    wm = bpy.context.window_manager
    ops = list(getattr(wm, "operators", []))
    current = set()
    for op in ops:
        ptr = op.as_pointer()
        current.add(ptr)
        if ptr in S.op_pointers or ptr in S.agent_op_pointers:
            continue
        _append({
            "ts": _now_iso(),
            "src": "user",
            "kind": "op",
            "op": op.bl_idname,
            "name": op.name,
            "props": _op_props(op),
        })
    S.op_pointers = current


# --------------------------------------------------------------------------
# Capture: depsgraph deltas (debounced)
# --------------------------------------------------------------------------

@persistent
def _on_depsgraph(scene, depsgraph=None) -> None:
    try:
        if S.agent_depth > 0 or S.user_jsonl is None:
            return
        if time.monotonic() - S.last_agent_time < _AGENT_GRACE_S:
            return  # deferred evaluation of an agent command, not a hand edit
        dg = depsgraph or bpy.context.evaluated_depsgraph_get()
        for upd in dg.updates:
            obj = upd.id
            if not isinstance(obj, bpy.types.Object):
                continue
            slot = S.pending_deltas.setdefault(
                obj.name, {"transform": False, "geometry": False}
            )
            slot["transform"] |= bool(upd.is_updated_transform)
            slot["geometry"] |= bool(upd.is_updated_geometry)
        if S.pending_deltas:
            S.last_delta_time = time.monotonic()
    except Exception:
        pass


def _flush_deltas() -> None:
    if not S.pending_deltas:
        return
    if time.monotonic() - S.last_delta_time < _DELTA_QUIET_S:
        return
    names = list(S.pending_deltas.keys())[:_MAX_DELTA_OBJECTS]
    objects = []
    for n in names:
        flags = S.pending_deltas[n]
        entry = {"name": n, **{k: v for k, v in flags.items() if v}}
        o = bpy.data.objects.get(n)
        if o is not None and flags.get("transform"):
            entry["loc"] = [round(v, 3) for v in o.location]
        objects.append(entry)
    dropped = max(0, len(S.pending_deltas) - _MAX_DELTA_OBJECTS)
    rec = {"ts": _now_iso(), "src": "user", "kind": "delta", "objects": objects}
    if dropped:
        rec["dropped"] = dropped
    S.pending_deltas = {}
    _append(rec)


# --------------------------------------------------------------------------
# Lifecycle
# --------------------------------------------------------------------------

def _tick() -> float:
    try:
        _hook_agent_executor()
        if S.user_jsonl is None:
            _retarget()
        if S.user_jsonl and not S.started_logged:
            S.started_logged = True
            _append({
                "ts": _now_iso(), "src": "user", "kind": "meta",
                "event": "user_tap_start", "blend": bpy.data.filepath,
            })
        if S.agent_depth == 0:
            _poll_operators()
        _flush_deltas()
    except Exception:
        pass
    return 1.0


@persistent
def _on_load_or_save(*_args) -> None:
    try:
        S.started_logged = False
        S.op_pointers = set()
        S.pending_deltas = {}
        _retarget()
    except Exception:
        pass


def register() -> None:
    # NOTE: bpy.data is restricted here — the first timer tick does _retarget().
    bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph)
    bpy.app.handlers.load_post.append(_on_load_or_save)
    bpy.app.handlers.save_post.append(_on_load_or_save)
    bpy.app.timers.register(_tick, first_interval=1.0, persistent=True)


def unregister() -> None:
    for handler_list, fn in (
        (bpy.app.handlers.depsgraph_update_post, _on_depsgraph),
        (bpy.app.handlers.load_post, _on_load_or_save),
        (bpy.app.handlers.save_post, _on_load_or_save),
    ):
        if fn in handler_list:
            handler_list.remove(fn)
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
