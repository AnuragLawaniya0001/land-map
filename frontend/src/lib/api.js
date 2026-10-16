import axios from "axios";

// Empty by default: requests go same-origin and the Vite dev server proxies /api
// to the backend, which keeps the auth cookie first-party.
export const BACKEND = import.meta.env.VITE_BACKEND_URL ?? "";
export const API = `${BACKEND}/api`;

export const api = axios.create({
  baseURL: API,
  withCredentials: true,
});

export const errMsg = (e) => {
  const d = e?.response?.data?.detail ?? e?.response?.data?.message;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d.map((item) => (typeof item === "string" ? item : (item?.msg || JSON.stringify(item)))).join("; ");
  }
  if (d && typeof d === "object") {
    return d.msg || d.message || JSON.stringify(d);
  }
  if (Array.isArray(e?.response?.data)) {
    return e.response.data.map((item) => item?.msg || JSON.stringify(item)).join("; ");
  }
  return e?.message && e.message !== "Network Error" ? e.message : "Request failed. Please check your inputs.";
};


export { toLeaflet, areaConversions, centroid as polygonCenter } from "@/lib/geo";
