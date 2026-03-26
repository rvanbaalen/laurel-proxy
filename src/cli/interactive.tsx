import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { loadConfig } from '../server/config.js';
import { RoxyProxyServer } from '../server/index.js';
import { findExistingInstances, killInstance, type ExistingInstance } from '../server/port-utils.js';
import { Database } from '../storage/db.js';
import { enableSystemProxy, disableSystemProxy, installCaCert, uninstallCaCert, checkCaStatus, checkSystemProxyStatus } from './system-proxy.js';
import type { CaStatus } from './system-proxy.js';
import type { RequestRecord } from '../shared/types.js';

// ── API helpers ──

function apiGet(port: number, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(port: number, urlPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => res.statusCode === 200 ? resolve() : reject());
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Menu ──

interface MenuItem {
  type: 'item';
  label: string;
  value: string;
  hint?: string;
  badge?: string;
  badgeColor?: string;
}

interface MenuHeading {
  type: 'heading';
  label: string;
}

type MenuEntry = MenuItem | MenuHeading;

function buildMenu(proxyRunning: boolean, caStatus: CaStatus, systemProxyEnabled: boolean): MenuEntry[] {
  const caBadge = !caStatus.exists
    ? { badge: 'not generated', badgeColor: 'gray' }
    : caStatus.trusted
      ? { badge: 'trusted', badgeColor: 'green' }
      : { badge: 'not trusted', badgeColor: 'yellow' };

  return [
    { type: 'heading', label: 'Proxy' },
    proxyRunning
      ? { type: 'item', label: 'Stop proxy', value: 'toggle-proxy', hint: 'Shut down the proxy server', badge: 'running', badgeColor: 'green' }
      : { type: 'item', label: 'Start proxy', value: 'toggle-proxy', hint: 'Launch the intercepting proxy', badge: 'stopped', badgeColor: 'red' },
    { type: 'item', label: 'Status', value: 'status', hint: 'View proxy status and stats' },

    { type: 'heading', label: 'Traffic' },
    { type: 'item', label: 'View requests', value: 'requests', hint: 'Browse captured traffic' },
    { type: 'item', label: 'Clear traffic', value: 'clear', hint: 'Delete all captured requests' },
    { type: 'item', label: 'Open web UI', value: 'open-ui', hint: 'Open dashboard in browser' },

    { type: 'heading', label: 'Setup' },
    { type: 'item', label: 'Trust CA certificate', value: 'trust-ca', hint: 'Install cert for HTTPS interception', ...caBadge },
    ...(caStatus.trusted ? [{ type: 'item' as const, label: 'Uninstall CA certificate', value: 'uninstall-ca', hint: 'Remove cert from system trust store' }] : []),
    systemProxyEnabled
      ? { type: 'item', label: 'Disable system proxy', value: 'toggle-system-proxy', hint: 'Restore direct connections', badge: 'enabled', badgeColor: 'green' }
      : { type: 'item', label: 'Enable system proxy', value: 'toggle-system-proxy', hint: 'Route all traffic through RoxyProxy', badge: 'disabled', badgeColor: 'gray' },

    { type: 'heading', label: '' },
    { type: 'item', label: 'Quit', value: 'quit' },
  ];
}

function GroupedMenu({ menu, cursor, onSelect }: { menu: MenuEntry[]; cursor: number; onSelect: (value: string) => void }) {
  let itemIndex = 0;

  useInput((_input, key) => {
    if (key.return) {
      const items = menu.filter((e): e is MenuItem => e.type === 'item');
      onSelect(items[cursor].value);
    }
  });

  return (
    <Box flexDirection="column">
      {menu.map((entry, i) => {
        if (entry.type === 'heading') {
          if (!entry.label) return <Text key={i}> </Text>;
          return (
            <Box key={i} marginTop={i > 0 ? 1 : 0}>
              <Text dimColor bold>{entry.label.toUpperCase()}</Text>
            </Box>
          );
        }

        const idx = itemIndex++;
        const selected = idx === cursor;

        return (
          <Box key={entry.value}>
            <Text color="cyan">{selected ? ' > ' : '   '}</Text>
            <Text bold={selected}>{entry.label}</Text>
            {entry.badge && (
              <Text color={entry.badgeColor as any}> [{entry.badge}]</Text>
            )}
            {entry.hint && selected ? <Text dimColor>  {entry.hint}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Header ──

function Header({ running }: { running: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan">{'  ___                ___                    '}</Text>
      <Text color="cyan">{' | _ \\___ __ ___  _ | _ \\_ _ _____ ___  _  '}</Text>
      <Text color="cyan">{' |   / _ \\\\ \\ / || || ___/ \'_/ _ \\ \\ /| || |'}</Text>
      <Text color="cyan">{' |_|_\\___//_\\_\\\\_, ||_|  |_| \\___/_\\_\\ \\_, |'}</Text>
      <Text color="cyan">{'                |__/                   |__/ '}</Text>
      <Box marginTop={0}>
        <Text dimColor>  HTTP/HTTPS intercepting proxy</Text>
        {running && <Text color="green">  ● running</Text>}
      </Box>
    </Box>
  );
}

// ── Sub-screens ──

type Screen = 'menu' | 'status' | 'requests' | 'request-detail' | 'working' | 'confirm-kill';

function StatusView({ onBack, port }: { onBack: () => void; port: number }) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet(port, '/api/status')
      .then(body => setStatus(JSON.parse(body)))
      .catch(() => setError('Proxy is not running.'));
  }, []);

  useInput((_input, key) => {
    if (key.escape || key.return) onBack();
  });

  if (error) return <Text color="red">  {error}</Text>;
  if (!status) return <Text dimColor>  Loading...</Text>;

  const running = status.running as boolean;
  const bytes = status.dbSizeBytes as number;
  const size = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <Box flexDirection="column">
      <Box><Text color={running ? 'green' : 'red'}>● </Text><Text bold>Status     </Text><Text color={running ? 'green' : 'red'}>{running ? 'Running' : 'Stopped'}</Text></Box>
      <Box><Text>  </Text><Text dimColor>Proxy      </Text><Text>port </Text><Text color="cyan">{String(status.proxyPort)}</Text></Box>
      <Box><Text>  </Text><Text dimColor>Requests   </Text><Text bold>{String(status.requestCount)}</Text></Box>
      <Box><Text>  </Text><Text dimColor>DB Size    </Text><Text>{size}</Text></Box>
      <Box marginTop={1}><Text dimColor>Enter or Esc to go back</Text></Box>
    </Box>
  );
}

function RequestsView({ onBack, onSelect }: { onBack: () => void; onSelect: (id: string) => void }) {
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const config = loadConfig();
    try {
      const db = new Database(config.dbPath);
      const result = db.query({ limit: 20 });
      setRequests(result.data);
      db.close();
    } catch {
      setError('Could not read database.');
    }
  }, []);

  useInput((_input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.upArrow && cursor > 0) setCursor(c => c - 1);
    if (key.downArrow && cursor < requests.length - 1) setCursor(c => c + 1);
    if (key.return && requests[cursor]) onSelect(requests[cursor].id);
  });

  if (error) return <Text color="red">  {error}</Text>;
  if (requests.length === 0) return (
    <Box flexDirection="column">
      <Text dimColor>  No requests captured yet.</Text>
      <Box marginTop={1}><Text dimColor>Esc to go back</Text></Box>
    </Box>
  );

  const methodColor = (m: string): string => {
    if (m === 'GET') return 'blue';
    if (m === 'POST') return 'green';
    if (m === 'PUT') return 'yellow';
    if (m === 'DELETE') return 'red';
    return 'white';
  };

  const statusColor = (s: number | null): string => {
    if (!s) return 'gray';
    if (s < 300) return 'green';
    if (s < 400) return 'yellow';
    if (s < 500) return 'magenta';
    return 'red';
  };

  return (
    <Box flexDirection="column">
      <Box><Text dimColor>{'  METHOD  STATUS  HOST                     PATH                      TIME'}</Text></Box>
      <Text dimColor>{'  ' + '─'.repeat(70)}</Text>
      {requests.map((r, i) => (
        <Box key={r.id}>
          <Text color="cyan">{i === cursor ? '> ' : '  '}</Text>
          <Text color={methodColor(r.method)}>{r.method.padEnd(8)}</Text>
          <Text color={statusColor(r.status)}>{String(r.status ?? '-').padEnd(8)}</Text>
          <Text>{r.host.slice(0, 24).padEnd(25)}</Text>
          <Text dimColor>{r.path.slice(0, 25).padEnd(26)}</Text>
          <Text dimColor>{r.duration ? `${r.duration}ms` : '-'}</Text>
        </Box>
      ))}
      <Box marginTop={1}><Text dimColor>{'↑↓ navigate  Enter select  Esc back'}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>  Filter with the CLI:</Text>
        <Text color="cyan">{'    roxyproxy requests --host example.com'}</Text>
        <Text color="cyan">{'    roxyproxy requests --status 500 --method POST'}</Text>
        <Text color="cyan">{'    roxyproxy requests --search "/api" --format table'}</Text>
        <Text color="cyan">{'    roxyproxy request <id>  '}<Text dimColor>{'# full detail for one request'}</Text></Text>
      </Box>
    </Box>
  );
}

function RequestDetailView({ requestId, onBack }: { requestId: string; onBack: () => void }) {
  const [record, setRecord] = useState<RequestRecord | null>(null);

  useEffect(() => {
    const config = loadConfig();
    try {
      const db = new Database(config.dbPath);
      setRecord(db.getById(requestId));
      db.close();
    } catch {}
  }, [requestId]);

  useInput((_input, key) => {
    if (key.escape || key.return) onBack();
  });

  if (!record) return <Text dimColor>  Loading...</Text>;

  const parseHeaders = (raw: string | null): Record<string, string> => {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  };

  const reqHeaders = parseHeaders(record.request_headers);
  const resHeaders = parseHeaders(record.response_headers);

  return (
    <Box flexDirection="column">
      <Box><Text dimColor>URL       </Text><Text color="cyan">{record.url}</Text></Box>
      <Box><Text dimColor>Method    </Text><Text color="blue">{record.method}</Text></Box>
      <Box><Text dimColor>Status    </Text><Text>{String(record.status)}</Text></Box>
      <Box><Text dimColor>Duration  </Text><Text>{record.duration}ms</Text></Box>
      <Box><Text dimColor>Protocol  </Text><Text>{record.protocol}</Text></Box>
      <Box><Text dimColor>Time      </Text><Text>{new Date(record.timestamp).toISOString()}</Text></Box>

      <Box marginTop={1}><Text bold>Request Headers</Text></Box>
      {Object.entries(reqHeaders).map(([k, v]) => (
        <Box key={k}><Text color="magenta">  {k}</Text><Text dimColor>: </Text><Text>{String(v)}</Text></Box>
      ))}

      <Box marginTop={1}><Text bold>Response Headers</Text></Box>
      {Object.entries(resHeaders).map(([k, v]) => (
        <Box key={k}><Text color="magenta">  {k}</Text><Text dimColor>: </Text><Text>{String(v)}</Text></Box>
      ))}

      {record.response_body && (
        <>
          <Box marginTop={1}><Text bold>Response Body</Text></Box>
          <Text>{formatBodyStr(record.response_body, record.content_type)}</Text>
        </>
      )}

      <Box marginTop={1}><Text dimColor>Enter or Esc to go back</Text></Box>
    </Box>
  );
}

function ConfirmKillView({ instances, onConfirm, onCancel }: { instances: ExistingInstance[]; onConfirm: () => void; onCancel: () => void }) {
  useInput((input) => {
    if (input.toLowerCase() === 'y') onConfirm();
    else if (input.toLowerCase() === 'n' || input === '\x1B') onCancel();
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="yellow">  ! Existing RoxyProxy instance{instances.length > 1 ? 's' : ''} detected:</Text>
      </Box>
      {instances.map((inst) => (
        <Box key={inst.pid}>
          <Text>    PID {inst.pid}</Text>
          {inst.ports.length > 0 && <Text dimColor>  (port{inst.ports.length > 1 ? 's' : ''} {inst.ports.join(', ')})</Text>}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text>  Kill existing instance{instances.length > 1 ? 's' : ''} and start? </Text>
        <Text color="cyan" bold>Y</Text><Text>/</Text><Text bold>N</Text>
      </Box>
    </Box>
  );
}

function formatBodyStr(body: Buffer | null, contentType: string | null): string {
  if (!body) return '(empty)';
  const str = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body);
  if (contentType?.includes('json')) {
    try { return JSON.stringify(JSON.parse(str), null, 2); } catch {}
  }
  return str.slice(0, 500);
}

// ── Main App ──

function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>('menu');
  const [workingLabel, setWorkingLabel] = useState('');
  const [message, setMessage] = useState('');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [server, setServer] = useState<RoxyProxyServer | null>(null);
  const [uiPort, setUiPort] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [caStatus, setCaStatus] = useState<CaStatus>({ exists: false, trusted: false, certPath: '' });
  const [systemProxyEnabled, setSystemProxyEnabled] = useState(false);
  const [pendingInstances, setPendingInstances] = useState<ExistingInstance[]>([]);

  // Check status on startup
  useEffect(() => {
    process.stdout.write('\x1B[2J\x1B[3J\x1B[H'); // clear screen + scrollback + cursor home
    checkCaStatus().then(setCaStatus);
    checkSystemProxyStatus().then(setSystemProxyEnabled);
  }, []);

  const [proxyRunning, setProxyRunning] = useState(false);

  // Poll actual proxy state to detect changes from web UI or API
  useEffect(() => {
    const check = () => setProxyRunning(server?.isProxyRunning ?? false);
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [server]);

  const menu = buildMenu(proxyRunning, caStatus, systemProxyEnabled);
  const selectableItems = menu.filter((e): e is MenuItem => e.type === 'item');

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || (screen === 'menu' && input === 'q')) {
      if (server) server.stop().then(() => exit());
      else exit();
      return;
    }
    if (screen !== 'menu') return;
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(selectableItems.length - 1, c + 1));
  });

  const doStartProxy = async () => {
    setScreen('working');
    setWorkingLabel('Starting proxy...');
    try {
      const config = loadConfig();
      const pidPath = path.join(os.homedir(), '.roxyproxy', 'pid');
      fs.mkdirSync(path.dirname(pidPath), { recursive: true });
      fs.writeFileSync(pidPath, process.pid.toString());
      const s = new RoxyProxyServer(config);
      const ports = await s.start();
      setServer(s);
      setUiPort(ports.uiPort);
      setMessage(`Proxy on :${ports.proxyPort}, UI on :${ports.uiPort}`);
    } catch (e) {
      setMessage(`Failed: ${(e as Error).message}`);
    }
    setScreen('menu');
  };

  const handleConfirmKill = async () => {
    setScreen('working');
    setWorkingLabel('Stopping existing instance...');
    for (const inst of pendingInstances) {
      const killed = await killInstance(inst);
      if (!killed) {
        setMessage(`Failed to stop instance PID ${inst.pid}`);
        setScreen('menu');
        return;
      }
    }
    setPendingInstances([]);
    await doStartProxy();
  };

  const handleCancelKill = () => {
    setPendingInstances([]);
    setMessage('Start cancelled.');
    setScreen('menu');
  };

  const handleSelect = async (value: string) => {
    setMessage('');
    switch (value) {
      case 'toggle-proxy': {
        if (proxyRunning && server) {
          setScreen('working');
          setWorkingLabel('Stopping proxy...');
          try {
            await apiPost(uiPort, '/api/proxy/stop');
            setMessage('Proxy stopped.');
          } catch {
            setMessage('Failed to stop proxy.');
          }
          setScreen('menu');
        } else if (!proxyRunning && server) {
          // Proxy was stopped externally (e.g. via web UI) — restart it
          setScreen('working');
          setWorkingLabel('Starting proxy...');
          try {
            await apiPost(uiPort, '/api/proxy/start');
            setMessage('Proxy restarted.');
          } catch (e) {
            setMessage(`Failed: ${(e as Error).message}`);
          }
          setScreen('menu');
        } else {
          // First start — check for existing instances
          setScreen('working');
          setWorkingLabel('Checking for existing instances...');
          const config = loadConfig();
          const existing = await findExistingInstances(config.proxyPort, config.uiPort);
          if (existing.length > 0) {
            setPendingInstances(existing);
            setScreen('confirm-kill');
          } else {
            await doStartProxy();
          }
        }
        break;
      }
      case 'status':
        setScreen('status');
        break;
      case 'requests':
        setScreen('requests');
        break;
      case 'clear': {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: uiPort, path: '/api/requests', method: 'DELETE' }, (res) => {
              res.resume();
              res.on('end', () => res.statusCode === 200 ? resolve() : reject());
            });
            req.on('error', reject);
            req.end();
          });
          setMessage('Traffic cleared.');
        } catch {
          try {
            const config = loadConfig();
            const db = new Database(config.dbPath);
            db.deleteAll();
            db.close();
            setMessage('Traffic cleared.');
          } catch {
            setMessage('Could not clear traffic.');
          }
        }
        break;
      }
      case 'open-ui': {
        if (!server) {
          // Check for existing instances before starting
          setScreen('working');
          setWorkingLabel('Checking for existing instances...');
          const config = loadConfig();
          const existing = await findExistingInstances(config.proxyPort, config.uiPort);
          if (existing.length > 0) {
            setPendingInstances(existing);
            setScreen('confirm-kill');
            break;
          }
          await doStartProxy();
        }
        const uiUrl = `http://127.0.0.1:${uiPort}`;
        const cmd = os.platform() === 'darwin' ? 'open' : os.platform() === 'win32' ? 'start' : 'xdg-open';
        execFile(cmd, [uiUrl], () => {});
        setMessage(`Opening ${uiUrl}`);
        setScreen('menu');
        break;
      }
      case 'trust-ca': {
        setScreen('working');
        setWorkingLabel('Installing CA certificate...');
        const caResult = await installCaCert();
        setMessage(caResult.message);
        // Refresh CA status
        const newStatus = await checkCaStatus();
        setCaStatus(newStatus);
        setScreen('menu');
        break;
      }
      case 'uninstall-ca': {
        setScreen('working');
        setWorkingLabel('Removing CA certificate...');
        const untrustResult = await uninstallCaCert();
        setMessage(untrustResult.message);
        const refreshedStatus = await checkCaStatus();
        setCaStatus(refreshedStatus);
        setScreen('menu');
        break;
      }
      case 'toggle-system-proxy': {
        if (systemProxyEnabled) {
          setScreen('working');
          setWorkingLabel('Disabling system proxy...');
          const offResult = await disableSystemProxy();
          setMessage(offResult.message);
          if (offResult.ok) setSystemProxyEnabled(false);
        } else {
          setScreen('working');
          setWorkingLabel('Enabling system proxy...');
          const onResult = await enableSystemProxy();
          setMessage(onResult.message);
          if (onResult.ok) setSystemProxyEnabled(true);
        }
        setScreen('menu');
        break;
      }
      case 'quit':
        if (server) await server.stop();
        exit();
        break;
    }
  };

  // Sub-screens
  if (screen === 'status') {
    return (<Box flexDirection="column" padding={1}><Header running={proxyRunning} /><StatusView onBack={() => setScreen('menu')} port={uiPort} /></Box>);
  }
  if (screen === 'requests') {
    return (<Box flexDirection="column" padding={1}><Header running={proxyRunning} /><RequestsView onBack={() => setScreen('menu')} onSelect={(id) => { setSelectedRequestId(id); setScreen('request-detail'); }} /></Box>);
  }
  if (screen === 'request-detail' && selectedRequestId) {
    return (<Box flexDirection="column" padding={1}><Header running={proxyRunning} /><RequestDetailView requestId={selectedRequestId} onBack={() => setScreen('requests')} /></Box>);
  }
  if (screen === 'confirm-kill') {
    return (<Box flexDirection="column" padding={1}><Header running={proxyRunning} /><ConfirmKillView instances={pendingInstances} onConfirm={handleConfirmKill} onCancel={handleCancelKill} /></Box>);
  }
  if (screen === 'working') {
    return (<Box flexDirection="column" padding={1}><Header running={proxyRunning} /><Text color="cyan">  {workingLabel}</Text></Box>);
  }

  // Main menu
  return (
    <Box flexDirection="column" padding={1}>
      <Header running={proxyRunning} />
      {!caStatus.exists && (
        <Box marginBottom={1}><Text color="yellow">  ! CA certificate not generated yet. Start the proxy first.</Text></Box>
      )}
      {caStatus.exists && !caStatus.trusted && (
        <Box marginBottom={1}><Text color="yellow">  ! CA certificate not trusted. Select "Trust CA certificate" to install.</Text></Box>
      )}
      <GroupedMenu menu={menu} cursor={cursor} onSelect={handleSelect} />
      {message && (
        <Box marginTop={1}>
          <Text dimColor>  {message}</Text>
        </Box>
      )}
    </Box>
  );
}

export async function launchInteractive(): Promise<void> {
  render(<App />);
}
