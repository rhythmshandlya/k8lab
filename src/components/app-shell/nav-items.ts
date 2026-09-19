import { type IconName } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Center navigation, left-to-right. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/problems", label: "Problems", icon: "problems" },
  { href: "/playground", label: "Playground", icon: "playground" },
  { href: "/docs", label: "Learn", icon: "docs" },
];

/** True when `pathname` is within `href`'s section (so `/problems/x` lights up Problems). */
export function isSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
