"use client";

import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { SignInResult } from "@/lib/review/sign-in";

type AuthState = {
  token: string | null;
  expirationTime: string | null;
};

type AuthContextValue = {
  token: string | null;
  expirationTime: string | null;
  setAuthPayload: (payload: SignInResult) => void;
  clearAuth: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    token: null,
    expirationTime: null,
  });

  const setAuthPayload = useCallback((payload: SignInResult) => {
    setState({
      token: payload.token,
      expirationTime: payload.expirationTime,
    });
  }, []);

  const clearAuth = useCallback(() => {
    setState({
      token: null,
      expirationTime: null,
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token: state.token,
      expirationTime: state.expirationTime,
      setAuthPayload,
      clearAuth,
    }),
    [state.expirationTime, state.token, setAuthPayload, clearAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}
