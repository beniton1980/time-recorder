import type { ReactNode } from "react";
import ManagerDashboardEnhancer from "./ManagerDashboardEnhancer";
import PayrollLinkNormalizer from "./PayrollLinkNormalizer";
import StoreSettingsDashboardLink from "./StoreSettingsDashboardLink";
import "./renewal.css";

export default function ManagerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ManagerDashboardEnhancer />
      <PayrollLinkNormalizer />
      <StoreSettingsDashboardLink />
      {children}
    </>
  );
}
