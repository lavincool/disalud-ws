import { describe, expect, test } from "bun:test";

import { isValidInternalBearer } from "./internal-auth.js";

const SECRET = "secreto-interno-de-pruebas-largo";

describe("isValidInternalBearer", () => {
  test("acepta el bearer correcto", () => {
    expect(isValidInternalBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  test("rechaza un secreto distinto de la misma longitud", () => {
    const falso = "x".repeat(SECRET.length);
    expect(isValidInternalBearer(`Bearer ${falso}`, SECRET)).toBe(false);
  });

  test("rechaza longitudes distintas sin que timingSafeEqual lance", () => {
    expect(isValidInternalBearer("Bearer corto", SECRET)).toBe(false);
    expect(isValidInternalBearer(`Bearer ${SECRET}demas`, SECRET)).toBe(false);
  });

  test("rechaza cabecera ausente, vacía o sin el prefijo Bearer", () => {
    expect(isValidInternalBearer(undefined, SECRET)).toBe(false);
    expect(isValidInternalBearer(null, SECRET)).toBe(false);
    expect(isValidInternalBearer("", SECRET)).toBe(false);
    expect(isValidInternalBearer(SECRET, SECRET)).toBe(false);
    expect(isValidInternalBearer(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  test("distingue mayúsculas en el prefijo", () => {
    expect(isValidInternalBearer(`bearer ${SECRET}`, SECRET)).toBe(false);
  });
});
