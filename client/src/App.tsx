import { isValidCode, normalizeCode } from '@pizzadrop/shared';
import { useState } from 'react';
import { AsciiBackground } from './components/AsciiBackground';
import { useSideLayout } from './hooks/useSideLayout';
import { BASE_PATH, pathSegment } from './lib/config';
import { ReceivePage } from './pages/ReceivePage';
import { SendPage } from './pages/SendPage';

type Route = { kind: 'send' } | { kind: 'receive'; code: string } | { kind: 'not-found' };

function parseRoute(pathname: string): Route {
  const segment = pathSegment(pathname);
  if (segment === null) return { kind: 'not-found' };
  if (segment === '') return { kind: 'send' };
  if (!segment.includes('/') && isValidCode(segment)) return { kind: 'receive', code: normalizeCode(segment) };
  return { kind: 'not-found' };
}

export function App() {
  const [route] = useState(() => parseRoute(location.pathname));
  const side = useSideLayout();
  const [energy, setEnergy] = useState(0);
  const [transferring, setTransferring] = useState(false);

  return (
    <>
      <AsciiBackground
        energy={energy}
        transferring={transferring}
        scene={route.kind === 'not-found' ? 'whole' : 'slice'}
      />
      <div className="app">
        <header className="topbar">
          <a className="brand" href={BASE_PATH} aria-label="PizzaDrop home">
            pizza<span className="brand__accent">drop</span>
          </a>
          <span className="topbar__tag">peer-to-peer file sharing</span>
        </header>
        {route.kind === 'send' && <SendPage setEnergy={setEnergy} setTransferring={setTransferring} />}
        {route.kind === 'receive' && (
          <ReceivePage code={route.code} setEnergy={setEnergy} setTransferring={setTransferring} />
        )}
        {route.kind === 'not-found' && (
          <main className={side ? 'stage stage--side' : 'stage'}>
            <section className="panel panel--card">
              <p className="error__title">No pizza here.</p>
              <p className="fine">
                That doesn’t look like a PizzaDrop link. Links look like {location.host}
                {BASE_PATH}x7k4q.
              </p>
              <a className="btn btn--primary" href={BASE_PATH}>
                share a file
              </a>
            </section>
          </main>
        )}
      </div>
    </>
  );
}
