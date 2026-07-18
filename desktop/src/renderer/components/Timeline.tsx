type DigestRecord =
  | {
      kind: 'batch';
      batch: string;
      srcRange: [number, number];
      trigger: string;
      model: string;
      status: string;
      ts: string;
    }
  | {
      kind: 'event';
      batch: string;
      type: string;
      src: number[];
      ts: string;
      tool?: string;
      summary: string;
      error?: { message: string; resolved: boolean; resolution?: string };
    };

export function Timeline({ records }: { records: unknown[] }) {
  const rows = records as DigestRecord[];
  if (rows.length === 0) {
    return (
      <div className="empty">
        <h3>No digest yet</h3>
        <p>
          Tier 1 appends events as the session runs. Click Update project memory for note + project
          state.
        </p>
      </div>
    );
  }

  const batches = new Map<
    string,
    { meta?: DigestRecord & { kind: 'batch' }; events: Array<DigestRecord & { kind: 'event' }> }
  >();

  for (const r of rows) {
    if (r.kind === 'batch') {
      const cur = batches.get(r.batch) ?? { events: [] };
      cur.meta = r;
      batches.set(r.batch, cur);
    } else if (r.kind === 'event') {
      const cur = batches.get(r.batch) ?? { events: [] };
      cur.events.push(r);
      batches.set(r.batch, cur);
    }
  }

  // Newest batch first.
  const ordered = [...batches.entries()].reverse();

  return (
    <div className="timeline">
      {ordered.map(([id, { meta, events }]) => (
        <div key={id} className="batch">
          <div className="batch-meta">
            {id}
            {meta && meta.kind === 'batch'
              ? ` · ${meta.trigger} · ${meta.status} · seq ${meta.srcRange[0]}–${meta.srcRange[1]}`
              : ''}
          </div>
          {events.map((ev, i) => (
            <div key={i} className="event">
              <span className={`event-type ${ev.type}`}>{ev.type}</span>
              <span className="event-summary">{ev.summary}</span>
              {ev.error && (
                <div style={{ color: 'var(--danger)', marginTop: 4, fontSize: '0.85rem' }}>
                  {ev.error.message}
                  {ev.error.resolved ? ' (resolved)' : ''}
                </div>
              )}
              <span className="event-src">src [{ev.src.join(', ')}]</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
