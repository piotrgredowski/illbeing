import { expect, test } from "bun:test";
import { createAdapter, resolveDataBackend } from "../../src/data/createAdapter";
import { GoogleDriveRatingsAdapter } from "../../src/data/adapters/googleDrive";
import { LocalApiRatingsAdapter } from "../../src/data/adapters/localApi";

test("resolveDataBackend defaults to google", () => {
  expect(resolveDataBackend(undefined)).toBe("google");
  expect(resolveDataBackend("anything")).toBe("google");
});

test("resolveDataBackend supports local_api", () => {
  expect(resolveDataBackend("local_api")).toBe("local_api");
});

test("createAdapter returns requested adapter", () => {
  const local = createAdapter("local_api");
  const google = createAdapter("google");

  expect(local).toBeInstanceOf(LocalApiRatingsAdapter);
  expect(google).toBeInstanceOf(GoogleDriveRatingsAdapter);
});
