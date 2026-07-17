/**
 * iOS のツールバーを縮めるための仕掛け (いわゆる天鳳方式)。
 *
 * iOS にはツールバーを操作するAPIが無い。ただし Safari は「ユーザーがスクロール
 * したらツールバーを縮める」挙動を持つので、わざとスクロールできる状態を作って
 * 縮めさせる。直接消しているのではなく、ブラウザに縮めさせている点に注意。
 *
 *   1. #root を sticky で画面上部に貼り付け、高さは dvh にする
 *      → スクロールしても画面から動かず、バーが縮んだぶんだけ伸びる
 *   2. その直後に1画面ぶんの spacer を置き、ページを約2画面分にしてスクロール可能にする
 *   3. 一度スクロールされたら案内を消す
 *
 * 対象は「タッチ端末」かつ「ホーム画面起動でない」場合のみ。
 * PCで縦スクロールが生まれると邪魔なだけだし、ホーム画面起動には元々バーが無い。
 */

/** 全画面API が使えるなら、そちらの方が確実なのでこの仕掛けは要らない。 */
const hasFullscreenApi = (): boolean => !!document.documentElement.requestFullscreen

const isTouch = (): boolean =>
  window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0

const isStandalone = (): boolean =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: fullscreen)').matches

export const shouldShrinkToolbar = (): boolean => {
  if (typeof window === 'undefined') return false
  return isTouch() && !isStandalone() && !hasFullscreenApi()
}

/**
 * 仕掛けを有効にする。解除用の関数を返す。
 * 卓の外 (spacer 部分) を上にスワイプするとツールバーが縮む。
 */
export const enableToolbarShrink = (): (() => void) => {
  const root = document.getElementById('root')
  if (!root || !root.parentNode) return () => {}

  document.documentElement.classList.add('fs-scroll')

  // もう1画面ぶんの余白。これがあるとページがスクロールできるようになる。
  const spacer = document.createElement('div')
  spacer.id = 'fs-spacer'
  root.parentNode.insertBefore(spacer, root.nextSibling)

  const sizeSpacer = () => {
    spacer.style.height = `${window.innerHeight}px`
  }
  sizeSpacer()

  // resize はバー収納中に連続で発火し、その都度 spacer を変えると
  // 収納が途中で止まってガタつく。向きの変更時だけ測り直す。
  const onOrientation = () => setTimeout(sizeSpacer, 300)
  window.addEventListener('orientationchange', onOrientation)

  return () => {
    window.removeEventListener('orientationchange', onOrientation)
    document.documentElement.classList.remove('fs-scroll')
    spacer.remove()
  }
}

/** 一度でもスクロールされたか (案内を消す判断に使う)。 */
export const onFirstScroll = (fn: () => void): (() => void) => {
  const h = () => {
    if ((window.scrollY || document.documentElement.scrollTop || 0) > 8) {
      fn()
      window.removeEventListener('scroll', h)
    }
  }
  window.addEventListener('scroll', h, { passive: true })
  return () => window.removeEventListener('scroll', h)
}
