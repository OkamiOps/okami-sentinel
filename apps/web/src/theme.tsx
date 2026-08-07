import { useEffect, type ReactNode } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "bench");
    document.documentElement.classList.add("dark");
  }, []);
  return children;
}
