import { describe, expect, it } from "vitest";

import { extractAimerCustomerCandidates } from "@/lib/aimer/candidate-customers";
import type { Event } from "@/lib/detection/types";

function makeEvent(overrides: Record<string, unknown>): Event {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T10:00:00.000000000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: null,
    level: "HIGH",
    triageScores: null,
    ...overrides,
  } as Event;
}

describe("extractAimerCustomerCandidates", () => {
  it("returns empty array when no customer fields are present", () => {
    expect(extractAimerCustomerCandidates(makeEvent({}))).toEqual([]);
  });

  it("reads the singular origCustomer", () => {
    const event = makeEvent({
      origCustomer: { id: "1", name: "Acme" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 1, name: "Acme" },
    ]);
  });

  it("reads the singular respCustomer", () => {
    const event = makeEvent({
      respCustomer: { id: "2", name: "Beta" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 2, name: "Beta" },
    ]);
  });

  it("reads the plural origCustomers (e.g. ExternalDdos)", () => {
    const event = makeEvent({
      origCustomers: [
        { id: "3", name: "Gamma" },
        { id: "4", name: "Delta" },
      ],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 3, name: "Gamma" },
      { id: 4, name: "Delta" },
    ]);
  });

  it("reads the plural respCustomers (e.g. MultiHostPortScan)", () => {
    const event = makeEvent({
      respCustomers: [
        { id: "5", name: "Epsilon" },
        { id: "6", name: "Zeta" },
      ],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 5, name: "Epsilon" },
      { id: 6, name: "Zeta" },
    ]);
  });

  it("merges both singular fields", () => {
    const event = makeEvent({
      origCustomer: { id: "7", name: "Eta" },
      respCustomer: { id: "8", name: "Theta" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 7, name: "Eta" },
      { id: 8, name: "Theta" },
    ]);
  });

  it("merges both plural fields", () => {
    const event = makeEvent({
      origCustomers: [{ id: "9", name: "Iota" }],
      respCustomers: [{ id: "10", name: "Kappa" }],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 9, name: "Iota" },
      { id: 10, name: "Kappa" },
    ]);
  });

  it("merges mixed singular and plural fields", () => {
    const event = makeEvent({
      origCustomer: { id: "11", name: "Lambda" },
      respCustomers: [{ id: "12", name: "Mu" }],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 11, name: "Lambda" },
      { id: 12, name: "Mu" },
    ]);
  });

  it("deduplicates by id across slots", () => {
    const event = makeEvent({
      origCustomer: { id: "13", name: "Nu" },
      respCustomer: { id: "13", name: "Nu (responder)" },
      origCustomers: [{ id: "14", name: "Xi" }],
      respCustomers: [{ id: "14", name: "Xi (responder)" }],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 13, name: "Nu" },
      { id: 14, name: "Xi" },
    ]);
  });

  it("drops malformed object missing id", () => {
    const event = makeEvent({
      origCustomer: { name: "Orphan" },
      respCustomer: { id: "15", name: "Pi" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 15, name: "Pi" },
    ]);
  });

  it("drops malformed object missing name", () => {
    const event = makeEvent({
      origCustomer: { id: "16" },
      respCustomer: { id: "17", name: "Rho" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 17, name: "Rho" },
    ]);
  });

  it("drops non-string id values", () => {
    const event = makeEvent({
      origCustomer: { id: 18, name: "Sigma" },
      respCustomer: { id: "19", name: "Tau" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 19, name: "Tau" },
    ]);
  });

  it("drops ids that don't round-trip as positive integers", () => {
    const event = makeEvent({
      origCustomers: [
        { id: "0", name: "Zero" },
        { id: "-3", name: "Negative" },
        { id: "7abc", name: "Suffix" },
        { id: "20", name: "Upsilon" },
      ],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 20, name: "Upsilon" },
    ]);
  });

  it("treats null and empty array fields as absent", () => {
    const event = makeEvent({
      origCustomer: null,
      respCustomer: null,
      origCustomers: [],
      respCustomers: [],
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([]);
  });

  it("treats non-array plural fields as absent", () => {
    const event = makeEvent({
      origCustomers: { id: "21", name: "Phi" },
      respCustomer: { id: "22", name: "Chi" },
    });
    expect(extractAimerCustomerCandidates(event)).toEqual([
      { id: 22, name: "Chi" },
    ]);
  });
});
