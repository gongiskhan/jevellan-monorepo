// SVG line icons on a 20 px grid and the brand flag, ported from gongiskhan/jevellan at 8e2788ec (apps/web/src/icons.tsx)
// with the icons the jv pages add (bot, memory, schedule, goal, job, doctor, usage, play, pause, refresh, cross,
// session, task). The UI shows no emoji anywhere (owner rule): every glyph is one of these.

import type { ReactNode } from 'react';

const paths = {
  attachment: <path d="M7 10l5-5a3 3 0 014 4l-7 7a4 4 0 01-6-6l7-7M6 11l6-6" />,
  agents: <><path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 01-10 0zM10 15v3" /></>,
  send: <path d="M10 16V4M4.5 9.5L10 4l5.5 5.5" />,
  queue: <><path d="M3 4h9M3 8h6M3 12h3" /><circle cx="13" cy="13" r="4.5" /><path d="M13 10.5V13l1.5 1" /></>,
  message: <path d="M3 3.5h14v10H8l-5 3z" />,
  gear: <><path d="M8 2h4l.5 2 1.5 1 2-.5 2 3-1.5 1.5v2L18 12.5l-2 3-2-.5-1.5 1-.5 2H8l-.5-2-1.5-1-2 .5-2-3L3.5 11V9L2 7.5l2-3 2 .5 1.5-1z" /><circle cx="10" cy="10" r="3" /></>,
  menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  plus: <path d="M10 4v12M4 10h12" />,
  chevron: <path d="M5.5 8l4.5 4.5L14.5 8" />,
  back: <path d="M12 4.5L6.5 10l5.5 5.5" />,
  more: (
    <>
      <circle cx="4.5" cy="10" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  runtimes: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="M6 8.5l2 1.8-2 1.8M10 12h4" />
    </>
  ),
  rigging: <path d="M10 2.5v15M10 3.5l6 11H10M10 5.5l-5 9h5M3 17.5h14" />,
  decisions: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 4.5l1.8 5.5L10 15.5 8.2 10z" fill="currentColor" stroke="none" />
    </>
  ),
  improver: (
    <>
      <path d="M15.5 12.2A6.3 6.3 0 017.8 4.5a6.3 6.3 0 107.7 7.7z" />
      <path d="M14 3.5v3M12.5 5h3" />
    </>
  ),
  devices: (
    <>
      <rect x="2.5" y="4" width="11" height="8" rx="1.2" />
      <path d="M1.5 14.5h13" />
      <rect x="14.5" y="7" width="4" height="9" rx="1" />
    </>
  ),
  projects: <path d="M2.5 5.5a1.5 1.5 0 011.5-1.5h3.6l1.8 2H16a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0116 16H4a1.5 1.5 0 01-1.5-1.5z" />,
  git: (
    <>
      <circle cx="6" cy="4.5" r="1.8" />
      <circle cx="6" cy="15.5" r="1.8" />
      <circle cx="14" cy="7.5" r="1.8" />
      <path d="M6 6.3v7.4M14 9.3c0 3-3.5 3.2-7.2 5" />
    </>
  ),
  configuration: (
    <>
      <path d="M5 2.5h7l3.5 3.5v11.5H5z" />
      <path d="M12 2.5V6h3.5M7.5 10h5M7.5 13h5" />
    </>
  ),
  about: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5M10 6.2v.1" />
    </>
  ),
  settings: (
    <>
      <path d="M3 6h9M15 6h2M3 14h2M8 14h9" />
      <circle cx="13.5" cy="6" r="1.8" />
      <circle cx="6.5" cy="14" r="1.8" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v1.6M10 15.9v1.6M2.5 10h1.6M15.9 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M4.7 15.3l1.1-1.1M14.2 5.8l1.1-1.1" />
    </>
  ),
  moon: <path d="M16.5 12A6.7 6.7 0 018 3.5a6.7 6.7 0 108.5 8.5z" />,
  system: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 3v14" />
      <path d="M10 3a7 7 0 010 14z" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M4 10.5l4 4 8-9" />,
  tune: <path d="M3 6h8M15 6h2M3 14h2M9 14h8M13 4v4M7 12v4" />,
  why: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.8 7.8a2.3 2.3 0 114 1.6c-.8.6-1.8 1.1-1.8 2.3M10 14.2v.1" />
    </>
  ),
  diff: (
    <>
      <path d="M6 3v8M2 7h8M3 15.5h7" />
      <path d="M13 4.5h4.5v12H11" />
    </>
  ),
  file: (
    <>
      <path d="M5 2.5h7l3.5 3.5v11.5H5z" />
      <path d="M12 2.5V6h3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.3 12.3L17 17" />
    </>
  ),
  external: <path d="M8 4H4.5v11.5H16V12M11 3.5h5.5V9M16.5 3.5L9 11" />,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.6" fill="currentColor" />,
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.8" />
      <path d="M13 7V5.3a1.8 1.8 0 00-1.8-1.8H5.3a1.8 1.8 0 00-1.8 1.8v5.9A1.8 1.8 0 005.3 13H7" />
    </>
  ),
  'pull-request': (
    <>
      <circle cx="6" cy="4.5" r="1.8" />
      <circle cx="6" cy="15.5" r="1.8" />
      <circle cx="14" cy="15.5" r="1.8" />
      <path d="M6 6.3v7.4M14 13.7V8.5a2.5 2.5 0 00-2.5-2.5H9M10.8 4.2L9 6l1.8 1.8" />
    </>
  ),
  thread: (
    <>
      <circle cx="4.5" cy="4.5" r="1.8" />
      <path d="M6.3 4.5H12a3 3 0 010 6H8a3 3 0 000 6h7.5" />
    </>
  ),
  trash: (
    <>
      <path d="M3.5 5.5h13M8 5.5V3.8c0-.4.4-.8.8-.8h2.4c.4 0 .8.4.8.8v1.7" />
      <path d="M5 5.5l.8 10.6c.1.8.7 1.4 1.5 1.4h5.4c.8 0 1.4-.6 1.5-1.4L15 5.5M8.3 8.5v5.8M11.7 8.5v5.8" />
    </>
  ),
  cross: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  bot: (
    <>
      <rect x="3.5" y="6" width="13" height="10" rx="2.5" />
      <path d="M10 6V3.5M7.5 10.5v.5M12.5 10.5v.5M7.5 13.5h5" />
    </>
  ),
  memory: (
    <>
      <path d="M6 3.5h8a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2v-9a2 2 0 012-2z" />
      <path d="M7 7.5h6M7 10.5h6M7 13.5h3.5" />
    </>
  ),
  schedule: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.2l2.8 1.8" />
    </>
  ),
  goal: (
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.5" />
      <circle cx="10" cy="10" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  job: (
    <>
      <rect x="3" y="6" width="14" height="10" rx="1.8" />
      <path d="M7.5 6V4.6c0-.6.5-1.1 1.1-1.1h2.8c.6 0 1.1.5 1.1 1.1V6M3 10.5h14" />
    </>
  ),
  doctor: <path d="M2.5 10h3.2l1.8-4.5 3 9 2-6 1.3 1.5h3.7" />,
  usage: <path d="M3.5 16.5h13M5.5 13.5v-3M9 13.5V6.5M12.5 13.5v-5M16 13.5V4" />,
  play: <path d="M6.5 4.5v11l9-5.5z" />,
  pause: <path d="M7 4.5v11M13 4.5v11" />,
  refresh: <path d="M15.5 8A6 6 0 004.6 7M4.5 12a6 6 0 0010.9 1M15.6 3.8V8h-4.2M4.4 16.2V12h4.2" />,
  session: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="M2.5 7.5h15M5.5 10.5h5M5.5 13h8" />
    </>
  ),
  task: (
    <>
      <rect x="3.5" y="3.5" width="13" height="13" rx="2.2" />
      <path d="M6.8 10.2l2.2 2.2 4.4-4.8" />
    </>
  ),
  link: <path d="M8.5 11.5a3.2 3.2 0 004.5 0l2.5-2.5a3.2 3.2 0 00-4.5-4.5l-1 1M11.5 8.5a3.2 3.2 0 00-4.5 0L4.5 11a3.2 3.2 0 004.5 4.5l1-1" />,
  terminal: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="M6 8.5l2 1.8-2 1.8M10 12h4" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  const node: ReactNode = paths[name];
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {node}
    </svg>
  );
}

// The Portuguese-flag tile from the website brand, with the magenta Jev dot.
export function BrandFlag() {
  return (
    <svg className="brand-flag" width="22" height="16" viewBox="1 5 31 23" aria-hidden="true">
      <defs>
        <clipPath id="brand-flag-clip">
          <rect x="1" y="5" width="30" height="22" rx="4" />
        </clipPath>
      </defs>
      <g clipPath="url(#brand-flag-clip)">
        <rect x="1" y="5" width="30" height="22" fill="#da291c" />
        <rect x="1" y="5" width="12" height="22" fill="#046a38" />
      </g>
      <circle cx="13" cy="16" r="5.4" fill="#ffe900" />
      <path d="M10.4 12.9h5.2v3.9c0 1.8-1.3 2.8-2.6 3.3-1.3-.5-2.6-1.5-2.6-3.3z" fill="#fff" stroke="#da291c" strokeWidth="1.3" />
    </svg>
  );
}
