"use client";

import { useEffect, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { cn } from "@/utils/cn";

function Avatar({
  src,
  name,
  size = 28,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
}) {
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? "User"}
        width={size}
        height={size}
        className="rounded-full object-cover border border-border-faint"
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center bg-heat-8 text-heat-100 text-label-small font-semibold"
      style={{ width: size, height: size }}
    >
      {initial}
    </div>
  );
}

export default function UserMenu() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (status === "loading") {
    return <div className="w-28 h-28 rounded-full bg-black-alpha-4 animate-pulse" />;
  }

  if (!session?.user) {
    return (
      <button
        type="button"
        className="px-12 py-6 rounded-8 text-label-small bg-heat-100 text-accent-white hover:bg-[color:var(--heat-90)] transition-all"
        onClick={() => signIn("google")}
      >
        Sign in
      </button>
    );
  }

  const { name, email, image } = session.user;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(
          "flex items-center gap-6 p-2 rounded-full transition-all",
          open ? "bg-black-alpha-4" : "hover:bg-black-alpha-4",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar src={image} name={name ?? email} size={28} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-6 w-[240px] bg-accent-white rounded-12 border border-border-muted overflow-hidden z-50"
          style={{
            boxShadow:
              "0px 16px 32px -8px rgba(0,0,0,0.08), 0px 4px 12px -2px rgba(0,0,0,0.04)",
          }}
        >
          <div className="flex items-center gap-10 px-12 py-12 border-b border-border-faint">
            <Avatar src={image} name={name ?? email} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-label-small text-accent-black truncate">
                {name ?? "Student"}
              </div>
              <div className="text-mono-x-small text-black-alpha-48 truncate">
                {email}
              </div>
            </div>
          </div>
          <div className="py-4">
            <button
              type="button"
              className="w-full flex items-center gap-8 px-12 py-8 text-label-small text-accent-black hover:bg-black-alpha-2 transition-all text-left"
              onClick={() => {
                setOpen(false);
                signOut({ callbackUrl: "/login" });
              }}
            >
              <svg
                fill="none"
                height="14"
                viewBox="0 0 24 24"
                width="14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-black-alpha-48"
              >
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
