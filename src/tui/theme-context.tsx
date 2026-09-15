import React, { createContext, useContext } from 'react';
import { palettes, type TerminalTheme, type ThemePalette } from './theme.js';

const PaletteContext = createContext<ThemePalette>(palettes.dark);

export function ThemeProvider({ theme, children }: { theme: TerminalTheme; children: React.ReactNode }) {
  return <PaletteContext.Provider value={palettes[theme]}>{children}</PaletteContext.Provider>;
}

export function usePalette(): ThemePalette { return useContext(PaletteContext); }
