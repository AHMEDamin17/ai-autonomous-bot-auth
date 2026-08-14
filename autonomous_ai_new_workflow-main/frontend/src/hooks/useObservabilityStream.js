import { useEffect, useState } from "react";
import { API_BASE_URL } from "../api/services";

export function useObservabilityStream(enabled = true) {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const apiKey = import.meta.env.VITE_API_KEY;
    if (!apiKey) {
      console.warn("API Key is missing");
      return;
    }
    const url = `${API_BASE_URL}/api/observability/stream?api_key=${encodeURIComponent(apiKey)}`;
    let es;
    let reconnectTimer;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      es = new EventSource(url);
      es.addEventListener("logs", (e) => {
        try {
          if (disposed) return;
          setLogs(JSON.parse(e.data).logs);
          setConnected(true);
        } catch {
          setLogs([]);
        }
      });
      es.onerror = () => {
        if (disposed) return;
        setConnected(false);
        es.close();
        reconnectTimer = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      disposed = true;
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, [enabled]);

  return { logs, connected };
}
