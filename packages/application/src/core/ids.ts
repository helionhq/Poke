import type { IdGenerator, IdPrefix } from "@poke/domain";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

/**
 * Time-sortable ids: `<prefix>_<10 chars time><16 chars random>`, monotonic within one process
 * (the random part increments when two ids share a millisecond), so ORDER BY id is creation order.
 */
export class SortableIds implements IdGenerator {
  #lastTime = -1;
  #lastRandom: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  next(prefix: IdPrefix): string {
    const time = this.now();
    let random: number[];
    if (time === this.#lastTime) {
      random = [...this.#lastRandom];
      for (let i = random.length - 1; i >= 0; i--) {
        if (random[i]! < 31) {
          random[i]!++;
          break;
        }
        random[i] = 0;
      }
    } else {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      random = [...bytes].map((byte) => byte % 32);
      // keep headroom so increments within one millisecond never wrap
      random[0] = random[0]! % 16;
    }
    this.#lastTime = time;
    this.#lastRandom = random;
    let timePart = "";
    let t = time;
    for (let i = 0; i < 10; i++) {
      timePart = ALPHABET[t % 32] + timePart;
      t = Math.floor(t / 32);
    }
    return `${prefix}_${timePart}${random.map((i) => ALPHABET[i]).join("")}`;
  }
}
