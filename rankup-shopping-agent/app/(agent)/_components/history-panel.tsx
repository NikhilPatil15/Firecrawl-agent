"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/utils/cn";

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function HistoryPanel({
  open,
  onClose,
  conversations,
  activeId,
  configured,
  onSelect,
  onNew,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  conversations: ConversationRow[];
  activeId: string | null;
  configured: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]" onClick={onClose} />
      <div
        ref={ref}
        className="fixed left-0 top-0 bottom-0 z-50 w-[320px] max-w-[86vw] bg-accent-white border-r border-border-muted flex flex-col"
        style={{ boxShadow: "0 0 60px -12px rgba(0,0,0,0.18)" }}
      >
        <div className="flex items-center justify-between px-16 py-14 border-b border-border-faint">
          <span className="text-label-medium text-accent-black tracking-tight">Your chats</span>
          <button
            type="button"
            onClick={onClose}
            className="p-6 rounded-8 text-black-alpha-40 hover:bg-black-alpha-4 hover:text-accent-black transition-all"
            aria-label="Close"
          >
            <svg fill="none" height="14" viewBox="0 0 24 24" width="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-12">
          <button
            type="button"
            onClick={() => { onNew(); onClose(); }}
            className="w-full flex items-center gap-8 px-12 py-10 rounded-10 bg-heat-8 text-heat-100 text-label-small font-medium hover:bg-heat-12 transition-all"
          >
            <svg fill="none" height="16" viewBox="0 0 24 24" width="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 pb-12" style={{ scrollbarWidth: "thin" }}>
          {!configured ? (
            <div className="px-12 py-16 text-body-small text-black-alpha-40 leading-relaxed">
              Chat history isn&apos;t set up yet. Add your Supabase keys to <span className="font-mono text-mono-x-small">.env.local</span> and run the schema.
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-12 py-16 text-body-small text-black-alpha-40">
              No saved chats yet. Your conversations will appear here.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {conversations.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => { onSelect(c.id); onClose(); }}
                    className={cn(
                      "w-full text-left pl-12 pr-32 py-10 rounded-10 transition-all",
                      activeId === c.id ? "bg-heat-8" : "hover:bg-black-alpha-3",
                    )}
                  >
                    <div className={cn("text-label-small truncate", activeId === c.id ? "text-heat-100" : "text-accent-black")}>
                      {c.title || "Untitled chat"}
                    </div>
                    <div className="text-mono-x-small text-black-alpha-32 mt-1">{relativeTime(c.updated_at)}</div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                    className="absolute right-8 top-1/2 -translate-y-1/2 p-6 rounded-8 text-black-alpha-24 opacity-0 group-hover:opacity-100 hover:text-accent-crimson hover:bg-black-alpha-4 transition-all"
                    aria-label="Delete chat"
                  >
                    <svg fill="none" height="13" viewBox="0 0 24 24" width="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /></svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
