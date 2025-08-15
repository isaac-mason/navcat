import { describe, expect, it } from "vitest";
import { type Vec3, vec3 } from "../dist";

describe("vec3", () => {
    describe("set", () => {
        it("should set the vector components", () => {
            const v: Vec3 = [0, 0, 0];
            vec3.set(v, 1, 2, 3);
            expect(v).toEqual([1, 2, 3]);
        });
    });
});
