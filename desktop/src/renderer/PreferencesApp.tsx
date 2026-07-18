import { useCallback, useEffect, useState } from 'react';
import type { InstallStatus, WrapResult } from '../../preload/index';
import { ControlPlane } from './components/ControlPlane';
import { Toast } from './components/Toast';

export default function PreferencesApp() {
  const [home, setHome] = useState('');
  const [runtime, setRuntime] = useState('');
  const [packaged, setPackaged] = useState(false);
  const [installStatus, setInstallStatus] = useState<InstallStatus | null>(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [envPath, setEnvPath] = useState('');
  const [migrateSources, setMigrateSources] = useState<
    Array<{ kind: string; path: string; label: string }>
  >([]);
  const [project, setProject] = useState('_unsaved');
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      await window.flightrec.ensureHome();
      const h = await window.flightrec.getHome();
      setHome(h.home);
      setRuntime(h.runtime ?? '');
      setPackaged(Boolean(h.packaged));
      const cfg = await window.flightrec.getConfig();
      const projs = await window.flightrec.listProjects();
      const ids = projs.map((p) => p.id);
      const proj =
        typeof cfg.lastProject === 'string' && ids.includes(cfg.lastProject)
          ? cfg.lastProject
          : (projs.find((p) => p.id !== '_unsaved')?.id ?? projs[0]?.id ?? '_unsaved');
      setProject(proj);
      setInstallStatus(await window.flightrec.installStatus());
      const key = await window.flightrec.apiKeyStatus();
      setApiKeySet(key.set);
      setEnvPath(key.envPath);
      const mig = await window.flightrec.migrateScan();
      setMigrateSources(mig.sources);
    } catch (err) {
      showToast(String(err), true);
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleWrap(server: string) {
    const result: WrapResult = await window.flightrec.wrap(server);
    showToast(result.ok ? `Wrapped ${server}` : `Wrap failed for ${server}`, !result.ok);
    if (result.restartHint) showToast('Restart MCP clients to pick up config');
    setInstallStatus(await window.flightrec.installStatus());
  }

  async function handleUninstall() {
    const result = await window.flightrec.uninstall();
    showToast('Uninstalled flightrec wraps');
    if (result.restartHint) showToast('Restart MCP clients to pick up config');
    setInstallStatus(await window.flightrec.installStatus());
  }

  async function handleLinkBlend() {
    const result = await window.flightrec.linkBlend(project);
    if (result.canceled) return;
    if (!result.ok) {
      showToast('Could not link .blend', true);
      return;
    }
    if (result.project) {
      setProject(result.project.id);
      await window.flightrec.setConfig({ lastProject: result.project.id });
      showToast(`Linked ${result.project.name}`);
    }
  }

  return (
    <div className="app prefs-app">
      <main className="main">
        <ControlPlane
          home={home}
          runtime={runtime}
          packaged={packaged}
          status={installStatus}
          apiKeySet={apiKeySet}
          envPath={envPath}
          migrateSources={migrateSources}
          onWrap={handleWrap}
          onUninstall={handleUninstall}
          onLinkBlend={() => void handleLinkBlend()}
          onRepairStore={async () => {
            const result = await window.flightrec.repairStore();
            showToast(
              result.ok ? 'Store paths updated to app data folder' : 'Repair failed',
              !result.ok
            );
            if (result.restartHint) showToast('Restart MCP clients to pick up config');
            setInstallStatus(await window.flightrec.installStatus());
          }}
          onSetKey={async (key) => {
            await window.flightrec.setApiKey(key);
            setApiKeySet(true);
            showToast('API key saved to app data .env');
          }}
          onClearKey={async () => {
            await window.flightrec.clearApiKey();
            setApiKeySet(false);
            showToast('API key cleared');
          }}
          onReveal={async (p) => {
            await window.flightrec.reveal(p);
          }}
          onCopy={async (p) => {
            await window.flightrec.copyPath(p);
            showToast('Copied path');
          }}
          onImport={async (src) => {
            const r = await window.flightrec.migrateImport(src, project);
            showToast(`Imported ${r.importedSessions} session(s)`);
            const mig = await window.flightrec.migrateScan();
            setMigrateSources(mig.sources);
          }}
          onRefresh={() => void refresh()}
        />
      </main>
      {toast && <Toast message={toast.msg} error={toast.error} />}
    </div>
  );
}
