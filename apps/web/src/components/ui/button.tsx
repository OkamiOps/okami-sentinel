import * as React from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-none",
  { variants: {
    variant: {
      default: "border-chart-1 bg-chart-1 text-primary-foreground hover:bg-chart-1/88",
      destructive: "border-destructive bg-destructive text-background hover:bg-destructive/88",
      configuration: "border-primary/60 bg-primary/[.10] text-primary shadow-[inset_3px_0_0_var(--primary)] hover:border-primary hover:bg-primary/[.17] hover:text-foreground",
      outline: "border-border bg-background/70 text-foreground hover:border-primary/60 hover:bg-accent",
      secondary: "border-border bg-secondary text-secondary-foreground hover:bg-secondary/70",
      ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
    },
    size: { default: "h-9 px-4", sm: "h-8 px-3", lg: "h-10 px-5", icon: "size-9 p-0", "icon-sm": "size-8 p-0" },
  }, defaultVariants: { variant: "default", size: "default" } },
)

function Button({ className, variant = "default", size = "default", asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
