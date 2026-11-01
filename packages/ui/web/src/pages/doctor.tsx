// /doctor (brief section 7): runs jv doctor on demand (GET /api/doctor, never on its own: the checks probe providers,
// ports and Jev) and shows one line per check: OK, WARN or FAIL, its name, the detail and the fix when there is one.

import { useState } from 'react';
import { getDoctor } from '../api.js';
import { ErrorLine, PageHeading } from '../components.js';
import { Icon } from '../icons.js';
import { localTime } from '../time.js';
import type { DoctorResult } from '../types.js';

export function DoctorPage() {
  const [result, setResult] = useState<DoctorResult>();
  const [at, setAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = () => {
    setBusy(true);
    setError(undefined);
    getDoctor()
      .then((value) => {
        setResult(value);
        setAt(new Date().toISOString());
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };
  const counts = { OK: 0, WARN: 0, FAIL: 0 } as Record<string, number>;
  for (const check of result?.checks ?? []) counts[check.status] = (counts[check.status] ?? 0) + 1;
  return (
    <div className="list-page doctor-page">
      <PageHeading title="Doctor" intro="The checks of jv doctor: the store, the skills, providers, Jev, ports, memory, the bot service.">
        <button type="button" disabled={busy} onClick={run}>
          <Icon name={busy ? 'refresh' : 'doctor'} size={15} />
          {busy ? 'Running...' : result ? 'Run again' : 'Run checks'}
        </button>
      </PageHeading>
      <ErrorLine text={error} />
      {!result && !busy && <p className="empty-inline">The checks run when you ask; they take a few seconds.</p>}
      {result && (
        <>
          <p className={`doctor-summary ${result.ok ? 'ok' : 'fail'}`} role="status">
            {result.ok ? 'Nothing failed' : 'Something failed'} · {counts.OK} ok, {counts.WARN} warn, {counts.FAIL} fail{at ? ` · ${localTime(at)}` : ''}
          </p>
          <ul className="doctor-list" aria-label="Checks">
            {result.checks.map((check) => (
              <li key={check.name} className={`doctor-line status-${check.status}`}>
                <span className={`doctor-status status-${check.status}`}>{check.status}</span>
                <span className="doctor-name">{check.name}</span>
                <span className="doctor-detail">{check.detail}</span>
                {check.fix && <span className="doctor-fix">fix: {check.fix}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
