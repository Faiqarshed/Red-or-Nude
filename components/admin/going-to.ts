"use client";

// The admin page a click is on its way to, from the moment of the click until
// the address changes. Set by Shell; read by the nav so the item it is going to
// lights up at once, and by Shell itself to show that page's skeleton at once.
import { createContext, useContext } from "react";

export const GoingToContext = createContext<string | null>(null);

export const useGoingTo = () => useContext(GoingToContext);
