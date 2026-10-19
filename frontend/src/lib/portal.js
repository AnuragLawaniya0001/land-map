import { useLocation } from "react-router-dom";

export const portalBase = (pathname) => {
  if (pathname.startsWith("/superadmin")) return "/superadmin";
  if (pathname.startsWith("/owner-panel")) return "/superadmin";
  if (pathname.startsWith("/owners-panel")) return "/superadmin";
  return "/admin";
};

export function usePortalBase() {
  const { pathname } = useLocation();
  return portalBase(pathname);
}

export const PORTALS = {
  admin: {
    base: "/admin",
    role: "admin",
    tag: "ADMIN WORKSPACE",
    title: "Admin sign in",
    eyebrow: "ADMIN PORTAL / SECURE",
    headline: ["Run your", "colonies", "from one map."],
    blurb: "Manage only the colonies you add: change plot status, publish your public link, and attach registry documents once a plot is sold.",
    hint: "Admins see and edit only their own colonies.",
  },
  super_admin: {
    base: "/superadmin",
    role: "super_admin",
    tag: "SUPER ADMIN",
    title: "Super Admin sign in",
    eyebrow: "SUPER ADMIN PORTAL / RESTRICTED",
    headline: ["Full control of", "every admin", "and colony."],
    blurb: "Create admin accounts, hand each admin their own public link, and oversee every colony on the platform.",
    hint: "Platform owner access only.",
  },
  owner: {
    base: "/superadmin",
    role: "super_admin",
    tag: "SUPER ADMIN",
    title: "Super Admin sign in",
    eyebrow: "SUPER ADMIN PORTAL / RESTRICTED",
    headline: ["Full control of", "every admin", "and colony."],
    blurb: "Create admin accounts, hand each admin their own public link, and oversee every colony on the platform.",
    hint: "Platform owner access only.",
  }
};
