import { useCallback, useEffect, useState } from "react";

export function useOtpCountdown(initial = 0) {
  const [deadline, setDeadline] = useState(() => Date.now() + initial * 1000);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  const setSeconds = useCallback((value: number) => {
    const current = Date.now();
    setNow(current);
    setDeadline(current + Math.max(0, value) * 1000);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return { seconds, setSeconds };
}
