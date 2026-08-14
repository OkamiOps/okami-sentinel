import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-none border border-border bg-background px-3 py-2 text-base shadow-[inset_2px_0_0_transparent] transition-[border-color,background-color,box-shadow] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/70 hover:border-foreground/25 hover:bg-accent/25 focus-visible:border-primary/70 focus-visible:bg-primary/[.035] focus-visible:shadow-[inset_2px_0_0_var(--primary)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/30 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-[inset_2px_0_0_var(--destructive)] md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
