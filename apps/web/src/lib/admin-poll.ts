import { useEffect, useRef } from 'react';

/** Poll only while this tab is visible. Skips overlapping ticks. */
export function useWhenVisiblePoll(load: () => void | Promise<void>, ms: number, enabled = true) {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (busy) return;
      busy = true;
      void Promise.resolve(loadRef.current()).finally(() => {
        busy = false;
      });
    };
    tick();
    const id = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, ms]);
}
