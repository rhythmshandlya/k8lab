"use client";

import type { CoreV1Event } from "@ngrok/webernetes";
import { useEffect, useMemo, useRef } from "react";

import { icons } from "@/components/icons";
import { eventAge } from "@/lib/kube/kubectl/format";
import { cn } from "@/lib/utils/cn";

function timeOf(event: CoreV1Event): number {
  const v = event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp;
  if (!v) return 0;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(ms) ? 0 : ms;
}

export function EventsTimeline({
  events,
  namespace = "default",
  onInspect,
}: {
  events: CoreV1Event[];
  namespace?: string;
  onInspect?: (events: readonly CoreV1Event[]) => void;
}) {
  const Warning = icons.warning;
  const Normal = icons.events;
  const filtered = useMemo(
    () =>
      [...events]
        .filter((e) => namespace === "*" || (e.metadata?.namespace ?? "default") === namespace)
        .sort((a, b) => timeOf(b) - timeOf(a)),
    [events, namespace],
  );
  const inspectedKey = filtered
    .map((event) => `${event.metadata?.uid ?? ""}:${event.reason ?? ""}:${event.message ?? ""}`)
    .join("\n");
  const lastInspectedRef = useRef("");
  useEffect(() => {
    if (!onInspect || inspectedKey === lastInspectedRef.current) return;
    lastInspectedRef.current = inspectedKey;
    onInspect(filtered);
  }, [filtered, inspectedKey, onInspect]);

  if (filtered.length === 0) {
    return <p className="text-subtle p-3 text-sm">No events yet.</p>;
  }

  return (
    <ul className="divide-border divide-y">
      {filtered.map((event, i) => {
        const warning = event.type === "Warning";
        const Icon = warning ? Warning : Normal;
        return (
          <li key={`${event.metadata?.uid ?? i}`} className="flex items-start gap-2.5 px-3 py-2">
            <Icon
              className={cn("mt-0.5 size-3.5 shrink-0", warning ? "text-amber" : "text-subtle")}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn("text-xs font-medium", warning ? "text-amber" : "text-muted")}>
                  {event.reason ?? "Event"}
                </span>
                <span className="tabnums text-subtle text-[10px]">{eventAge(event)}</span>
                {namespace === "*" ? (
                  <span className="text-subtle text-[10px]">
                    {event.metadata?.namespace ?? "default"}
                  </span>
                ) : null}
              </div>
              <p className="text-muted truncate text-xs" title={event.message ?? ""}>
                {event.message ?? ""}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
