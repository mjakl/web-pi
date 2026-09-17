/**
 * Every icon pi-web draws, copied from its components: same viewBox, same
 * stroke width, same path data. pi-web has no icon library — each icon is a
 * hand-written SVG — so this file is the whole inventory, and the one place an
 * area may take an icon from. Comment numbers retain the original port's
 * inventory numbering.
 *
 * All of them are `fill: none; stroke: currentColor` with round caps and joins
 * unless the source says otherwise, so colour and hover come from the button
 * around them.
 */

import { type CatppuccinIconName, catppuccinIcon } from "@core/file-types";

// Browser-created controls use the same inventory without a JSX renderer.
export const TAB_CLOSE_ICON = `<svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="8" y2="8"></line><line x1="8" y1="2" x2="2" y2="8"></line></svg>`;
export const ATTACHMENT_REMOVE_ICON = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="1" x2="7" y2="7"></line><line x1="7" y1="1" x2="1" y2="7"></line></svg>`;
export const IMAGE_PREVIEW_CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>`;

type IconProps = { size?: number };

/** The shape every stroked icon shares. */
function Stroked({
  size,
  box = 24,
  width = 2,
  cap = "round",
  join = "round",
  children,
}: {
  size: number;
  /** The square viewBox pi-web drew the icon in. */
  box?: number;
  width?: number;
  cap?: "round" | "butt";
  join?: "round" | "miter" | undefined;
  children?: unknown;
}) {
  // pi-web sets flexShrink:0 on its icons; without it an svg in an
  // overflow:hidden flex row (a session row's branch chip) is squashed.
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(box)} ${String(box)}`}
      fill="none"
      stroke="currentColor"
      stroke-width={String(width)}
      stroke-linecap={cap}
      {...(join === undefined ? {} : { "stroke-linejoin": join })}
      class="pi-icon"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* 1 · trust warning in the top bar */
export function TrustShieldIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Stroked>
  );
}

/* 2 · refresh: page, session list, explorer, retry banner */
export function RefreshIcon({
  size = 14,
  width = 1.8,
}: IconProps & {
  width?: number;
}) {
  return (
    <Stroked size={size} width={width}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Stroked>
  );
}

/* 3 · full history */
export function HistoryIcon({ size = 12 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </Stroked>
  );
}

/* 4 · system prompt */
export function SystemPromptIcon({ size = 12 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </Stroked>
  );
}

/* 5 · tools */
export function WrenchIcon({ size = 12 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
    </Stroked>
  );
}

/* 6 · input / output token counters */
export function TokenArrowIcon({
  size = 12,
  direction,
}: IconProps & { direction: "in" | "out" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {direction === "in" ? (
        <>
          <line x1="5" y1="8.5" x2="5" y2="1.5" />
          <polyline points="2 4 5 1.5 8 4" />
        </>
      ) : (
        <>
          <line x1="5" y1="1.5" x2="5" y2="8.5" />
          <polyline points="2 6 5 8.5 8 6" />
        </>
      )}
    </svg>
  );
}

/* 7 · cache-read counter */
export function CacheReadIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" />
      <polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
    </svg>
  );
}

/* 8 · context usage gauge */
export function ContextGaugeIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" />
      <line x1="1" y1="9" x2="9" y2="9" />
    </svg>
  );
}

/* 9 · file panel toggle / hide */
export function PanelRightIcon({ size = 16 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </Stroked>
  );
}

/* 10 · sidebar toggle, open */
export function PanelLeftIcon({ size = 16 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </Stroked>
  );
}

/* 11 · sidebar toggle, closed */
export function HamburgerIcon({ size = 18 }: IconProps) {
  return (
    <Stroked size={size} width={2} join={undefined}>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </Stroked>
  );
}

/* 12 · close the mobile "more" strip */
export function CloseIcon({ size = 15 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </Stroked>
  );
}

/* 13 · more menus, session row menu */
export function MoreDotsIcon({
  size = 17,
  radius = 1.5,
}: IconProps & { radius?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r={radius} />
      <circle cx="12" cy="12" r={radius} />
      <circle cx="19" cy="12" r={radius} />
    </svg>
  );
}

/* 14 · copy */
export function CopyIcon({
  size = 12,
  width = 2,
}: IconProps & {
  width?: number;
}) {
  return (
    <Stroked size={size} width={width}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Stroked>
  );
}

/* 15 · copied / refreshed / compacted confirmation */
export function CheckIcon({
  size = 12,
  width = 2,
}: IconProps & {
  width?: number;
}) {
  return (
    <Stroked size={size} width={width}>
      <polyline points="20 6 9 17 4 12" />
    </Stroked>
  );
}

/* 16 · get-started arrow */
export function GetStartedArrowIcon({ size = 44 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.7"
      aria-hidden="true"
    >
      <line x1="20" y1="12" x2="4" y2="12" />
      <polyline points="10 6 4 12 10 18" />
    </svg>
  );
}

/* 17 · new session */
export function PlusIcon({
  size = 12,
  width = 2.2,
}: IconProps & { width?: number }) {
  return (
    <Stroked size={size} box={12} width={width}>
      <line x1="6" y1="1" x2="6" y2="11" />
      <line x1="1" y1="6" x2="11" y2="6" />
    </Stroked>
  );
}

/* 18 · custom path */
export function SmallPlusIcon({ size = 10 }: IconProps) {
  return (
    <Stroked size={size} box={10} width={1.1}>
      <line x1="5" y1="1" x2="5" y2="9" />
      <line x1="1" y1="5" x2="9" y2="5" />
    </Stroked>
  );
}

/* 19 · explorer and directory chevrons (rotate 90deg when open) */
export function SmallChevronIcon({
  size = 9,
  width = 1.8,
}: IconProps & {
  width?: number;
}) {
  return (
    <Stroked size={size} box={10} width={width}>
      <polyline points="3 2 7 5 3 8" />
    </Stroked>
  );
}

/* 20 · changed-files toggle */
export function ChangedFilesIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6" />
      <path d="M15 12h6" />
    </Stroked>
  );
}

/* 21 · search */
export function SearchIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </Stroked>
  );
}

/* 22 · running spinner; CSS honors reduced motion without script. */
export function SpinnerIcon({
  size = 14,
  animated = true,
}: IconProps & { animated?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class={`pi-spinner${animated ? " is-animated" : ""}`}
    >
      <g>
        <path
          d="M21 12a9 9 0 1 1-3.8-7.4"
          stroke="currentColor"
          stroke-width="2.8"
          stroke-linecap="round"
        />
      </g>
    </svg>
  );
}

/* 23 · active session dot */
export function ActiveDotIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5" fill="currentColor" />
    </svg>
  );
}

/* 24 · stopped session ring */
export function StoppedRingIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r="4.5"
        stroke="currentColor"
        stroke-width="1.25"
        opacity="0.6"
      />
    </svg>
  );
}

/* 25 · worktree branch badge on a session row */
export function BranchBadgeIcon({ size = 9 }: IconProps) {
  return (
    <Stroked size={size} width={2.4}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Stroked>
  );
}

/* 26 · star */
export function StarIcon({
  size = 14,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39L17.56 20 12 17.13 6.44 20l1.06-6.07L3 9.54l6.22-.91L12 3Z" />
    </svg>
  );
}

/* 27 · folder in the workspace menu. Drawn without cap or join attributes,
   as ProjectFolderGroup.tsx does, so the corners stay mitred. */
export function ProjectFolderIcon({ size = 13 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path d="M3 7V5h6l2 2h10v13H3Z" />
    </svg>
  );
}

/* 28 · worktree group chevron (rotate 90deg when expanded) */
export function ChevronRightIcon({ size = 13 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

/* 29 · @ mention */
export function MentionIcon({ size = 14 }: IconProps) {
  return (
    <Stroked size={size} width={2.2}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </Stroked>
  );
}

/* 30 · directory loading spokes (static) */
export function DirectoryLoadingIcon({ size = 10 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--text-dim)"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
    </svg>
  );
}

/* 31 · download */
export function DownloadIcon({ size = 14 }: IconProps) {
  return (
    <Stroked size={size} width={2.2}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Stroked>
  );
}

/* 32 · clear search */
export function ClearSearchIcon({ size = 10 }: IconProps) {
  return (
    <Stroked size={size} width={2.4}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Stroked>
  );
}

/* 33 · close tab */
export function TabCloseIcon({ size = 11 }: IconProps) {
  return (
    <Stroked size={size} box={10} width={1.8}>
      <line x1="2" y1="2" x2="8" y2="8" />
      <line x1="8" y1="2" x2="2" y2="8" />
    </Stroked>
  );
}

/* 34 · folder row in the directory picker */
export function PickerFolderIcon({ size = 14 }: IconProps) {
  return (
    <Stroked size={size} box={16} width={1.3}>
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </Stroked>
  );
}

/* 35 · drive row in the directory picker */
export function PickerDriveIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" />
    </svg>
  );
}

/* 36 · go to the parent directory */
export function ParentFolderIcon({ size = 16 }: IconProps) {
  return (
    <Stroked size={size} width={1.8}>
      <path d="m18 15-6-6-6 6" />
    </Stroked>
  );
}

/* 37 · process-details chevron (rotate 90deg when expanded) */
export function ProcessChevronIcon({ size = 12 }: IconProps) {
  return (
    <Stroked size={size} box={12} width={1.6}>
      <polyline points="4 2.5 7.5 6 4 9.5" />
    </Stroked>
  );
}

/* 38 · drop zone: a picture frame with mountains and a sun */
export function DropZoneIcon({ size = 280 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 140 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="chat-drop-zone-icon"
      aria-hidden="true"
    >
      <rect
        x="28"
        y="44"
        width="84"
        height="60"
        rx="8"
        fill="rgba(37,99,235,0.08)"
        stroke="rgba(37,99,235,0.50)"
        stroke-width="1.8"
      />
      <path
        d="M36 100 L54 72 L68 88 L80 74 L104 100Z"
        fill="rgba(37,99,235,0.16)"
        stroke="rgba(37,99,235,0.40)"
        stroke-width="1.4"
        stroke-linejoin="round"
      />
      <circle
        cx="96"
        cy="58"
        r="8"
        fill="rgba(37,99,235,0.22)"
        stroke="rgba(37,99,235,0.55)"
        stroke-width="1.6"
      />
      <g
        stroke="rgba(37,99,235,0.45)"
        stroke-width="1.4"
        stroke-linecap="round"
      >
        <line x1="96" y1="46" x2="96" y2="43" />
        <line x1="96" y1="70" x2="96" y2="73" />
        <line x1="84" y1="58" x2="81" y2="58" />
        <line x1="108" y1="58" x2="111" y2="58" />
        <line x1="87.5" y1="49.5" x2="85.4" y2="47.4" />
        <line x1="104.5" y1="66.5" x2="106.6" y2="68.6" />
        <line x1="104.5" y1="49.5" x2="106.6" y2="47.4" />
        <line x1="87.5" y1="66.5" x2="85.4" y2="68.6" />
      </g>
    </svg>
  );
}

/* 39 · slash-command expander (rotate 180deg when expanded) */
export function ExpandChevronIcon({ size = 11 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <polyline points="6 9 12 15 18 9" />
    </Stroked>
  );
}

/* 40 · rewind a user message */
export function RewindIcon({ size = 11 }: IconProps) {
  return (
    <Stroked size={size} width={1.8}>
      <path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2" />
    </Stroked>
  );
}

/* 41 · thinking / tool call / custom / subagent chevrons */
export function CardChevronIcon({
  size = 10,
  colour = "var(--text-dim)",
}: IconProps & { colour?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke={colour}
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );
}

/* 42 · compact the context; also the compaction marker */
export function CompactIcon({ size = 14 }: IconProps) {
  return (
    <Stroked size={size} width={1.8}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="10" y1="14" x2="3" y2="21" />
      <line x1="21" y1="3" x2="14" y2="10" />
    </Stroked>
  );
}

/* 43 · stop a running compaction */
export function StopCompactionIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

/* 45 · new session from here (fork) */
export function ForkIcon({ size = 11 }: IconProps) {
  return (
    <Stroked size={size} width={1.8} cap="butt">
      <path d="M6 3v12M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </Stroked>
  );
}

/* 46 · jump to the latest message */
export function JumpToLatestIcon({ size = 15 }: IconProps) {
  return (
    <Stroked size={size} width={2.2}>
      <path d="M12 4v13" />
      <path d="m6 12 6 6 6-6" />
    </Stroked>
  );
}

/* 47 · model error / warning banner */
export function WarningTriangleIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Stroked>
  );
}

/* 48 · recall the queue into the composer */
export function RecallQueueIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </Stroked>
  );
}

/* 49 · remove an attached image */
export function RemoveImageIcon({ size = 8 }: IconProps) {
  return (
    <Stroked size={size} box={8} width={1.5} join={undefined}>
      <line x1="1" y1="1" x2="7" y2="7" />
      <line x1="7" y1="1" x2="1" y2="7" />
    </Stroked>
  );
}

/* 50 · attach an image */
export function AttachImageIcon({ size = 18 }: IconProps) {
  return (
    <Stroked size={size} width={1.8} join={undefined}>
      <path d="M12 5v14M5 12h14" />
    </Stroked>
  );
}

/* 51 · the composer's primary action */
export function ComposerActionIcon({
  size = 16,
  action,
}: IconProps & { action: "send" | "stop" | "steer" | "followup" }) {
  return (
    <Stroked size={size} width={1.8}>
      {action === "stop" ? (
        <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
      ) : action === "followup" ? (
        <path d="M4 6h14M4 12h8M4 18h8m6-6v8m-4-4h8" />
      ) : action === "steer" ? (
        <path d="M5 19v-5a4 4 0 0 1 4-4h10m-5-5 5 5-5 5" />
      ) : (
        <path d="M12 19V5m-7 7 7-7 7 7" />
      )}
    </Stroked>
  );
}

/* 52 · the model selector while a switch is in flight */
export function ModelSwitchingIcon({ size = 11 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      aria-hidden="true"
      class="model-switching-icon"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    </svg>
  );
}

/* 53 · model selector chevron */
export function ChevronDownIcon({
  size = 12,
  colour = "var(--text-dim)",
}: IconProps & { colour?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colour}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/* 54 · the selected model in the model menu */
export function ModelCheckIcon({ size = 10 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="var(--accent)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="1.5 5 4 7.5 8.5 2.5" />
    </svg>
  );
}

/* 55 · which side of the composer a widget panel opens on */
export function WidgetPlacementIcon({
  placement,
}: {
  placement: "above" | "below";
}) {
  return (
    <svg
      width="8"
      height="6"
      viewBox="0 0 8 6"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={placement === "above" ? "M4 0l4 6H0z" : "M0 0h8L4 6z"} />
    </svg>
  );
}

/* 56 · the mermaid zoom dialog's toolbar */
export function ZoomOutIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M5 12h14" />
    </Stroked>
  );
}

export function ZoomInIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M12 5v14M5 12h14" />
    </Stroked>
  );
}

export function ZoomFitIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </Stroked>
  );
}

export function ZoomCloseIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Stroked>
  );
}

/* 57 · close the image lightbox */
export function LightboxCloseIcon({ size = 16 }: IconProps) {
  return (
    <Stroked size={size} width={2} join={undefined}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Stroked>
  );
}

/* 58 · wrap long lines in the file viewer */
export function WrapLinesIcon({ size = 14 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M3 6h18" />
      <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
      <path d="m16 16-2 2 2 2" />
      <path d="M3 18h7" />
    </Stroked>
  );
}

/* 59 · the settings sections */
export function SettingsSectionIcon({
  section,
  size = 16,
  width = 1.8,
}: IconProps & {
  section: "general" | "models" | "skills" | "plugins";
  width?: number;
}) {
  const shape =
    section === "general" || section === "models" ? (
      <>
        <path d="M20 7h-9M14 17H5" />
        <circle cx="7" cy="7" r="3" />
        <circle cx="17" cy="17" r="3" />
      </>
    ) : section === "skills" ? (
      <>
        <path d="m12 2-10 5 10 5 10-5-10-5Z" />
        <path d="m2 12 10 5 10-5M2 17l10 5 10-5" />
      </>
    ) : (
      <path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={String(width)}
      stroke-linecap="round"
      stroke-linejoin="round"
      class="settings-section-icon"
      aria-hidden="true"
    >
      {shape}
    </svg>
  );
}

/* 60 · the theme radio group */
export function ThemeIcon({
  preference,
  size = 17,
}: IconProps & { preference: "light" | "dark" | "auto" }) {
  if (preference === "light") {
    return (
      <Stroked size={size} width={1.8} join={undefined}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" />
      </Stroked>
    );
  }
  if (preference === "dark") {
    return (
      <Stroked size={size} width={1.8}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </Stroked>
    );
  }
  return (
    <Stroked size={size} width={1.8}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Stroked>
  );
}

/* 61 · add a skill or a plugin */
export function AddConfigIcon({ size = 13 }: IconProps) {
  return (
    <Stroked size={size} width={2}>
      <path d="M12 5v14M5 12h14" />
    </Stroked>
  );
}

/* 62 · the pi.dev logo (fixed black in both themes, as in pi-web) */
export function PiDevLogoIcon({ size = 28 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 800 800"
      aria-hidden="true"
      focusable="false"
      class="pi-icon"
    >
      <path
        fill="#000"
        fill-rule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="#000" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

/* 63 · the project trust dialog */
export function TrustDialogShieldIcon({ size = 20 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--warning)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/* 64 · the rail's branch graph is drawn by the rail itself: bezier paths
   "M px py C px y, x py, x y", stroke var(--text-dim), width 2 active / 1. */

// --- Catppuccin file icons -------------------------------------------------
//
// Not shown in their own colours: `.catppuccin-file-icon` (shell.css) masks
// the SVG with `var(--text-dim)`, and `html.dark` swaps in the mocha file. The
// two URLs are set per icon, inline, exactly as pi-web does it.

const CATPPUCCIN_ROOT = "/static/icons/catppuccin";

function CatppuccinIcon({ name }: { name: CatppuccinIconName }) {
  return (
    <span
      aria-hidden="true"
      class="catppuccin-file-icon"
      style={`--catppuccin-icon-light: url(${CATPPUCCIN_ROOT}/latte/${name}.svg); --catppuccin-icon-dark: url(${CATPPUCCIN_ROOT}/mocha/${name}.svg)`}
    />
  );
}

export function FolderIcon({ open = false }: { open?: boolean }) {
  return <CatppuccinIcon name={open ? "_folder_open" : "_folder"} />;
}

/** The icon for a file name; `catppuccinIcon` in the core picks which. */
export function FileIcon({ name }: { name: string }) {
  return <CatppuccinIcon name={catppuccinIcon(name)} />;
}
