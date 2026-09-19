"use client";
import { useSyncExternalStore } from "react";
import { PROGRESS_EVENT } from "@/lib/storage/local-progress";
import { getIdentity } from "@/lib/storage/progress-store";
const subscribe = (callback: () => void) => {
  window.addEventListener(PROGRESS_EVENT, callback);
  return () => window.removeEventListener(PROGRESS_EVENT, callback);
};
export function useProblemOwner() {
  return useSyncExternalStore(subscribe, getIdentity, () => null);
}
