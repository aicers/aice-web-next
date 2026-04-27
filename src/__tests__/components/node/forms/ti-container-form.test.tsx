/**
 * TI Container (Tivan) form interactive coverage.
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TiContainerForm } from "@/components/node/forms/ti-container-form";

import { renderForm } from "./test-rig";

interface TiContainerValues {
  tiContainer: { webIp: string; webPort: number };
}

const PRESET: TiContainerValues["tiContainer"] = {
  webIp: "10.0.0.3",
  webPort: 8444,
};

describe("TiContainerForm", () => {
  it("renders a Web IP/Port pair with the hydrated values", () => {
    renderForm<TiContainerValues>(<TiContainerForm />, {
      defaultValues: { tiContainer: PRESET },
    });
    const ip = document.getElementById(
      "tiContainer-web-ip",
    ) as HTMLInputElement | null;
    const port = document.getElementById(
      "tiContainer-web-port",
    ) as HTMLInputElement | null;
    expect(ip).not.toBeNull();
    expect(port).not.toBeNull();
    expect(ip?.value).toBe("10.0.0.3");
    expect(port?.value).toBe("8444");
  });

  it("surfaces inline errors for both webIp and webPort", async () => {
    renderForm<TiContainerValues>(<TiContainerForm />, {
      defaultValues: { tiContainer: PRESET },
      errors: {
        "tiContainer.webIp": "ip error",
        "tiContainer.webPort": "port error",
      },
    });
    expect(await screen.findByText("ip error")).toBeTruthy();
    expect(screen.getByText("port error")).toBeTruthy();
  });
});
