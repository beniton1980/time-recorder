import type { ReactNode } from "react";
import ManagerDashboardEnhancer from "./ManagerDashboardEnhancer";
import "./renewal.css";

export default function ManagerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ManagerDashboardEnhancer />
      {children}
    </>
  );
}
