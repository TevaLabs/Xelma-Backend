import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

describe("isApiOnlyMode()", () => {
  let originalApiOnly: string | undefined;

  beforeEach(() => {
    originalApiOnly = process.env.API_ONLY;
    delete process.env.API_ONLY;
    jest.resetModules();
  });

  afterEach(() => {
    if (originalApiOnly === undefined) {
      delete process.env.API_ONLY;
    } else {
      process.env.API_ONLY = originalApiOnly;
    }
    jest.resetModules();
  });

  it("returns false when API_ONLY is unset", () => {
    const { isApiOnlyMode } = require("../index");
    expect(isApiOnlyMode()).toBe(false);
  });

  it('returns true when API_ONLY is "true"', () => {
    process.env.API_ONLY = "true";
    const { isApiOnlyMode } = require("../index");
    expect(isApiOnlyMode()).toBe(true);
  });

  it('returns true when API_ONLY is "TRUE" (case-insensitive)', () => {
    process.env.API_ONLY = "TRUE";
    const { isApiOnlyMode } = require("../index");
    expect(isApiOnlyMode()).toBe(true);
  });

  it('returns false when API_ONLY is "false"', () => {
    process.env.API_ONLY = "false";
    const { isApiOnlyMode } = require("../index");
    expect(isApiOnlyMode()).toBe(false);
  });

  it("returns false for arbitrary non-true values", () => {
    process.env.API_ONLY = "1";
    const { isApiOnlyMode } = require("../index");
    expect(isApiOnlyMode()).toBe(false);
  });
});
