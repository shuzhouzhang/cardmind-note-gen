"use client"
 
import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"
 
export function ThemeProvider({
  children,
  scriptProps,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      {...props}
      scriptProps={
        typeof window === 'undefined'
          ? scriptProps
          : { ...scriptProps, type: 'application/json' }
      }
    >
      {children}
    </NextThemesProvider>
  )
}
