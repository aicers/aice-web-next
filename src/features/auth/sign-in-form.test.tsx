import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import { SignInForm } from "./sign-in-form";

vi.mock("@/lib/review/sign-in", () => ({
  signIn: vi.fn(),
}));

const { signIn } = await import("@/lib/review/sign-in");
const signInMock = vi.mocked(signIn);

beforeEach(() => {
  signInMock.mockReset();
});

describe("SignInForm", () => {
  it("submits credentials and renders token on success", async () => {
    const expirationTime = new Date("2030-01-01T00:00:00Z").toISOString();
    signInMock.mockResolvedValue({
      token: "mock-token",
      expirationTime,
    });

    renderWithProviders(<SignInForm />);

    await userEvent.type(screen.getByLabelText(/Username/i), "test-user");
    await userEvent.type(screen.getByLabelText(/Password/i), "hunter2!");

    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith({
        username: "test-user",
        password: "hunter2!",
      }),
    );

    await waitFor(() =>
      expect(screen.getByText(/Signed in successfully/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("mock-token")).toBeInTheDocument();
  });

  it("shows validation messages when credentials are missing", async () => {
    renderWithProviders(<SignInForm />);
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(signInMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Username is required/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Password is required/i),
    ).toBeInTheDocument();
  });
});
