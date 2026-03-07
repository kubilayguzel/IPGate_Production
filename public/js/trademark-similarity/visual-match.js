const visualMap = {
  "a": ["e", "o"],
  "b": ["d", "p"],
  "c": ["ç", "s"],
  "ç": ["c", "s"],
  "d": ["b", "p"],
  "e": ["a", "o"],
  "f": ["t"],
  "g": ["ğ", "q"],
  "ğ": ["g", "q"],
  "h": ["n"],
  "i": ["l", "j", "ı"],
  "ı": ["i"],
  "j": ["i", "y"],
  "k": ["q", "x"],
  "l": ["i", "1"],
  "m": ["n"],
  "n": ["m", "r"],
  "o": ["a", "0", "ö"],
  "ö": ["o"],
  "p": ["b", "q"],
  "q": ["g", "k"],
  "r": ["n"],
  "s": ["ş", "c", "z"],
  "ş": ["s", "z"],
  "t": ["f"],
  "u": ["ü", "v"],
  "ü": ["u", "v"],
  "v": ["u", "ü", "w"],
  "w": ["v"],
  "x": ["ks"],
  "y": ["j"],
  "z": ["s", "ş"],
  "0": ["o"],
  "1": ["l", "i"],
  "ks": ["x"],
  "Q": ["O","0"],
  "O": ["Q", "0"],
  "I": ["l", "1"],
  "L": ["I", "1"],
  "Z": ["2"],
  "S": ["5"],
  "B": ["8"],
  "D": ["O"]
};

/**
 * Görsel benzerlik tabanlı harf farkı cezası hesaplar.
 * Harf uzunlukları farklı olsa da karşılaştırma yapılır.
 * Ek kelime veya uzunluk farkı → ek ceza (0.5 * fark).
 */
export function visualMismatchPenalty(a, b) {
  if (!a || !b) return 5; // Herhangi biri boşsa yüksek ceza

  const lenDiff = Math.abs(a.length - b.length);
  const minLen = Math.min(a.length, b.length);
  let penalty = lenDiff * 0.5; // uzunluk farkı başına ceza

  for (let i = 0; i < minLen; i++) {
    const ca = a[i].toLowerCase();
    const cb = b[i].toLowerCase();

    if (ca !== cb) {
      if (visualMap[ca] && visualMap[ca].includes(cb)) { // visualMap[ca] null/undefined değilse kontrol et
        penalty += 0.25;  // görsel benzer harf → düşük ceza
      } else {
        penalty += 1.0;   // normal farklı harf → normal ceza
      }
    }
  }

  return penalty;
}