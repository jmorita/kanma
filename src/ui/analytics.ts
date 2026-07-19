/**
 * アクセス計測。Vercel Web Analytics のカスタムイベントで
 * 「遊ばれたか」を測る。cookie を使わないので同意バナーは不要。
 *
 * 取得するイベント:
 *   game_start   … 開始ボタン押下 (人数 / 端末 / 牌の背の色 も一緒に送る)
 *   round_end    … 1局完了 (和了=tsumo/ron / 流局=draw)
 *   session_end  … 離脱時にセッション長(秒)と局数を送る (熱中度の目安)
 *
 * dev やプレビューでは Vercel 側が送信しないが、window.__hammaEvents には
 * 常に積むので、実際に発火しているかを手元で確認できる。
 */
import { track } from '@vercel/analytics'

type Props = Record<string, string | number | boolean>

declare global {
  interface Window {
    __hammaEvents?: { name: string; props?: Props; t: number }[]
  }
}

// ページを開いてから離れるまでを1セッションとみなす (熱中度の近似)。
const sessionStart = Date.now()
let roundsThisSession = 0
let sessionSent = false

const emit = (name: string, props?: Props): void => {
  try {
    track(name, props)
  } catch {
    /* 計測の失敗でゲームを止めない */
  }
  if (typeof window !== 'undefined') {
    ;(window.__hammaEvents ??= []).push({ name, props, t: Date.now() })
  }
}

/** 端末の大まかな区別。タッチ主体をスマホ扱いにする。 */
const device = (): 'mobile' | 'pc' =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'pc'

/** 開始ボタン押下。実際にプレイを始めたか（最初の関門）。 */
export const trackGameStart = (opts: { seats: number; back: string }): void => {
  roundsThisSession = 0
  emit('game_start', { seats: opts.seats, device: device(), back: opts.back })
}

/** 1局が終わったとき。和了(tsumo/ron)か流局(draw)か。 */
export const trackRoundEnd = (result: 'tsumo' | 'ron' | 'draw'): void => {
  roundsThisSession += 1
  emit('round_end', { result })
}

/*
 * セッション長。タブを閉じる/バックグラウンドへ回した最初のタイミングで1回だけ送る。
 * タブ切替で早めに送られることはあるが、概算として十分。
 */
const endSession = (): void => {
  if (sessionSent) return
  sessionSent = true
  emit('session_end', {
    seconds: Math.round((Date.now() - sessionStart) / 1000),
    rounds: roundsThisSession,
  })
}

if (typeof document !== 'undefined') {
  // visibilitychange(hidden) はモバイルでも比較的確実に発火する離脱シグナル。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endSession()
  })
  window.addEventListener('pagehide', endSession)
}
