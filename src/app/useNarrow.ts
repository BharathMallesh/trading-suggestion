// Shared responsive helper: true when the viewport is narrower than `threshold`.
import { useEffect, useState } from 'react';

export function useNarrow(threshold = 760): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < threshold : false));
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < threshold);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [threshold]);
  return narrow;
}
