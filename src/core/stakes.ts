/**
 * 仮想レート / レーキ (コミッション)。
 *
 * 韓麻はカジノ運用で「レートに応じたコミッション(場代)を審判に支払う」
 * 「局開始時にデポジット額を持っていないと次へ進めない」とされている。
 * ここではその構造だけを模した**仮想チップ**を扱う。実際の金銭は一切扱わない。
 *
 * ゲーム進行 (core/game.ts) はこの層を知らない。点数の増減だけを出力し、
 * それをチップに換算するのがこのモジュールの役目。
 */

export interface StakeSettings {
  /** 1点あたりの額 (W)。 */
  rate: number
  /** レーキ率(%)。和了者の受取から差し引かれ、ハウスへ回る。 */
  rakePercent: number
  /** 局開始に必要なデポジット。持っていないと次局へ進めない。 */
  deposit: number
  /** 開始時の持ち額。 */
  startingChips: number
}

export const DEFAULT_STAKES: StakeSettings = {
  rate: 100, // 1点 = 100W
  rakePercent: 10, // 和了者の受取から10%
  deposit: 2000, // 20点ぶん (= 20 * rate)
  startingChips: 20000,
}

/** 設定で選べるレーキ率。刻みを絞って、極端な値を入れられないようにする。 */
export const RAKE_CHOICES = [10, 5, 0] as const

/** レートを掛けない「レートなし」モード。点数だけで遊ぶとき用。 */
export const NO_STAKES: StakeSettings = {
  rate: 0,
  rakePercent: 0,
  deposit: 0,
  startingChips: 0,
}

export interface Settlement {
  /** 各席のチップ増減 (レーキ適用後)。 */
  chipDeltas: number[]
  /** ハウスが取ったレーキ。 */
  rake: number
}

/**
 * 局の点数増減をチップに換算する。
 * レーキは和了者の受取からのみ差し引く (放銃者の支払いは増えない)。
 */
export const settle = (pointDeltas: readonly number[], stakes: StakeSettings): Settlement => {
  // レート0のとき -0 が生まれ、表示が "-0" になってしまうので正規化する。
  const chipDeltas = pointDeltas.map((d) => {
    const v = d * stakes.rate
    return v === 0 ? 0 : v
  })
  let rake = 0
  for (let i = 0; i < chipDeltas.length; i++) {
    if (chipDeltas[i] <= 0) continue
    const cut = Math.floor((chipDeltas[i] * stakes.rakePercent) / 100)
    chipDeltas[i] -= cut
    rake += cut
  }
  return { chipDeltas, rake }
}

/** デポジットを払えず次局に進めない席。 */
export const shortOfDeposit = (chips: readonly number[], stakes: StakeSettings): number[] => {
  const out: number[] = []
  for (let i = 0; i < chips.length; i++) if (chips[i] < stakes.deposit) out.push(i)
  return out
}

export const formatChips = (n: number): string => n.toLocaleString('ja-JP')
