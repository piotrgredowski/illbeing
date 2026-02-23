import { expect, test } from "bun:test";
import { MissingGoogleClientIdError } from "../../src/data/adapters/googleDrive";
import {
  nextThemePreference,
  parseRatingInput,
  resolveInitFailureStatus,
  resolveSignInLabelKey,
  shouldRefreshWeekChart,
} from "../../src/app/logic";

test("parseRatingInput accepts only integer values from 1 to 10", () => {
  expect(parseRatingInput("7")).toBe(7);
  expect(parseRatingInput(" 10 ")).toBe(10);
  expect(parseRatingInput("0")).toBeNull();
  expect(parseRatingInput("11")).toBeNull();
  expect(parseRatingInput("3.5")).toBeNull();
  expect(parseRatingInput("bad")).toBeNull();
});

test("week chart refresh only occurs for week tab", () => {
  expect(shouldRefreshWeekChart("entry")).toBe(false);
  expect(shouldRefreshWeekChart("week")).toBe(true);
  expect(shouldRefreshWeekChart("settings")).toBe(false);
});

test("sign in label key follows connection state", () => {
  expect(resolveSignInLabelKey(false)).toBe("auth.signIn");
  expect(resolveSignInLabelKey(true)).toBe("auth.connected");
});

test("boot failure status mapping keeps adapter-specific messaging", () => {
  expect(resolveInitFailureStatus("google", new MissingGoogleClientIdError())).toEqual({
    key: "status.missingClientId",
    isError: true,
  });

  expect(resolveInitFailureStatus("local_api", new Error("offline"))).toEqual({
    key: "status.localApiUnavailable",
    isError: true,
  });

  expect(resolveInitFailureStatus("google", new Error("unknown"))).toEqual({
    key: "status.googleClientInitFailed",
    isError: true,
  });
});

test("nextThemePreference cycles light, dark and system", () => {
  expect(nextThemePreference("light")).toBe("dark");
  expect(nextThemePreference("dark")).toBe("system");
  expect(nextThemePreference("system")).toBe("light");
});
