import { useCallback, useEffect, useReducer, useState } from 'react'
import {
  createGame,
  discard,
  declareTsumo,
  declareSelfKan,
  respondCall,
  turnOptions,
  wallRemaining,
  seatName,
  type GameState,
  type Seat,
  type Player,
  type Meld,
} from '../core/game'
import { DEFAULT_RULES } from '../core/score'
import { DEFAULT_STAKES, RAKE_CHOICES, settle, shortOfDeposit, formatChips, type StakeSettings } from '../core/stakes'
import { tileName, type Tile as TileId } from '../core/tiles'
import { cpuTurnAction, cpuCallResponse } from '../ai/cpu'
import { Tile, type Dir } from './Tile'
import { RulesPanel } from './RulesPanel'
import { sfx, setSoundEnabled, unlockAudio } from './sound'
import { BACK_COLORS, pickBackColor, type BackColor, type BackColorSetting } from './backColor'
import { isFullscreen, onFullscreenChange, supportsFullscreen, toggleFullscreen } from './fullscreen'
import { enableToolbarShrink, onFirstScroll, shouldShrinkToolbar } from './toolbarShrink'

const HUMAN: Seat = 0
// 各プレイヤーのアクションの間隔。速すぎると何が起きたか追えない。
const CPU_DELAY_MS = 1000

/**
 * 席を画面のどの辺に置くか。人間は常に手前。
 * 4人打ち: 手前/右/奥/左, 3人打ち: 手前/右/左 (対面なし)。
 */
const dirsFor = (seatCount: number): Dir[] =>
  seatCount === 3 ? ['bottom', 'right', 'left'] : ['bottom', 'right', 'top', 'left']

type Tab = 'table' | 'rules' | 'settings'

export const App = () => {
  const [seatCount, setSeatCount] = useState(4)
  const [stakes, setStakes] = useState<StakeSettings>(DEFAULT_STAKES)
  const [tab, setTab] = useState<Tab>('table')
  /** 鳴きなし: ポン・カンの確認を出さず自動で見送る (ロンは通す)。 */
  const [noCall, setNoCall] = useState(false)
  /** 自動和了: 和了れる場面で自動的にツモ・ロンする。 */
  const [autoWin, setAutoWin] = useState(false)
  /** リーチ後の自動ツモ切り: 和了牌でもカンでもなければ自動で切る。 */
  const [autoTsumogiri, setAutoTsumogiri] = useState(false)
  const [sound, setSound] = useState(true)
  /** デバッグモード: 他家の手牌を開ける。j を素早く2回で切替。 */
  const [debug, setDebug] = useState(false)
  /** ポン/リーチ/ロン/ツモ の演出。表示中は進行を止める。 */
  const [effect, setEffect] = useState<{ text: string; dir: Dir; kind: string } | null>(null)
  /** 牌の背の色。random は卓を立てるたびに選び直す。 */
  const [backSetting, setBackSetting] = useState<BackColorSetting>('random')
  const [back, setBack] = useState<BackColor>(() => pickBackColor('random'))
  const [fs, setFs] = useState(false)
  /**
   * ダブルタップ打牌。1回目のタップで牌を持ち上げ、同じ牌をもう一度タップして初めて切る。
   * 誤打が起きやすいので既定はこちら。設定タブでシングルタップにもできる。
   */
  const [confirmTap, setConfirmTap] = useState(true)
  /** 確認待ちの牌 (タップ確認がONのとき)。 */
  const [pending, setPending] = useState<TileId | null>(null)
  /**
   * 開始前かどうか。いきなり配牌が始まらないようにする。
   * ブラウザは操作なしに音を鳴らせないので、開始のタップで効果音も有効になる。
   */
  const [started, setStarted] = useState(false)

  // ESC等で全画面を抜けた場合もボタンの表示を合わせる
  useEffect(() => {
    setFs(isFullscreen())
    return onFullscreenChange(setFs)
  }, [])

  /** iOS のツールバーを縮める案内を出すか (一度スワイプされたら消す)。 */
  const [shrinkHint, setShrinkHint] = useState(false)
  useEffect(() => {
    if (!shouldShrinkToolbar()) return
    const off = enableToolbarShrink()
    setShrinkHint(true)
    const offScroll = onFirstScroll(() => setShrinkHint(false))
    return () => {
      off()
      offScroll()
    }
  }, [])

  // リーチは2点固定。
  const rules = DEFAULT_RULES

  const [game, setGame] = useState<GameState>(() => createGame({ seatCount: 4, rules }))
  const [points, setPoints] = useState<number[]>(() => new Array(4).fill(0))
  const [chips, setChips] = useState<number[]>(() => new Array(4).fill(DEFAULT_STAKES.startingChips))
  const [houseRake, setHouseRake] = useState(0)
  const [settled, setSettled] = useState(false)
  const [tick, force] = useReducer((x: number) => x + 1, 0)

  game.rules = rules

  const dirs = dirsFor(game.seatCount)

  /** 掛け声の演出を出し、その間だけ進行を止める。 */
  const announce = useCallback(
    (kind: 'pon' | 'kan' | 'riichi' | 'ron' | 'tsumo', seat: Seat) => {
      const text = { pon: 'ポン', kan: 'カン', riichi: 'リーチ', ron: 'ロン', tsumo: 'ツモ' }[kind]
      setEffect({ text, dir: dirsFor(game.seatCount)[seat], kind })
      sfx[kind]()
      if (kind === 'ron' || kind === 'tsumo') sfx.win()
    },
    [game.seatCount],
  )

  // 演出はしばらく出したあと自動で消す。消えると進行が再開する。
  useEffect(() => {
    if (!effect) return
    const id = setTimeout(() => setEffect(null), effect.kind === 'ron' || effect.kind === 'tsumo' ? 1100 : 800)
    return () => clearTimeout(id)
  }, [effect])

  useEffect(() => setSoundEnabled(sound), [sound])

  // 手番や局が変わったら確認待ちを解除する。
  // 残っていると次の手番の1タップ目でいきなり切れてしまう。
  useEffect(() => {
    if (game.turn !== HUMAN || game.phase !== 'discard') setPending(null)
  }, [game.turn, game.phase, tick])

  // "jj" (j を素早く2回) でデバッグモードを切り替える。
  useEffect(() => {
    let lastJ = 0
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'j' || e.repeat) return
      const t = e.timeStamp
      if (t - lastJ < 500) {
        setDebug((v) => !v)
        lastJ = 0
      } else {
        lastJ = t
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** 卓を張り直す (人数やレートを変えたとき)。 */
  const resetTable = useCallback(
    (count: number, st: StakeSettings) => {
      setSeatCount(count)
      setPoints(new Array(count).fill(0))
      setChips(new Array(count).fill(st.startingChips))
      setHouseRake(0)
      setSettled(false)
      setGame(createGame({ seatCount: count, rules }))
      setTab('table')
    },
    [rules],
  )

  // 局が終わったら1度だけ精算する。
  useEffect(() => {
    if (game.phase !== 'end' || settled || !game.result) return
    const deltas = game.result.deltas
    const { chipDeltas, rake } = settle(deltas, stakes)
    setPoints((p) => p.map((v, i) => v + deltas[i]))
    setChips((c) => c.map((v, i) => v + chipDeltas[i]))
    setHouseRake((r) => r + rake)
    setSettled(true)
    if (game.result.winner === null) sfx.draw_game()
    else sfx.win()
  }, [game.phase, game.result, settled, stakes])

  const broke = shortOfDeposit(chips, stakes)
  const canContinue = broke.length === 0

  const nextHand = useCallback(() => {
    setSettled(false)
    setBack(pickBackColor(backSetting))
    setGame(createGame({ seatCount, dealer: (game.dealer + 1) % seatCount, rules }))
  }, [game.dealer, seatCount, rules, backSetting])

  // 鳴きなし / 自動和了。人間の応答を自動で返す。
  useEffect(() => {
    if (!started || effect) return
    if (game.phase === 'call') {
      const mc = game.pendingCalls.find((c) => c.seat === HUMAN && c.response === null)
      if (!mc) return
      if (autoWin && mc.options.includes('ron')) {
        // 自動でも間を置く。即座に処理すると何が起きたか分からない。
        const id = setTimeout(() => {
          respondCall(game, HUMAN, 'ron')
          announce('ron', HUMAN)
          force()
        }, CPU_DELAY_MS)
        return () => clearTimeout(id)
      }
      // 鳴きなしでもロンは取りこぼさない。
      if (noCall && !mc.options.includes('ron')) {
        respondCall(game, HUMAN, 'pass')
        force()
      }
      return
    }
    if (game.phase !== 'discard' || game.turn !== HUMAN) return
    const o = turnOptions(game, HUMAN)

    if (autoWin && o.canTsumo) {
      // 自動でも間を置く。
      const id = setTimeout(() => {
        declareTsumo(game, HUMAN)
        announce('tsumo', HUMAN)
        force()
      }, CPU_DELAY_MS)
      return () => clearTimeout(id)
    }

    // リーチ後の自動ツモ切り。和了牌やカンできる牌まで黙って切らないよう、
    // ツモ・カンの選択肢が無いときだけ自動で切る。
    if (
      autoTsumogiri &&
      game.players[HUMAN].riichi &&
      game.drawnTile !== null &&
      !o.canTsumo &&
      o.kanTiles.length === 0
    ) {
      // 自動でも他家と同じ間を置く。即座に切ると何が起きたか追えない。
      const id = setTimeout(() => {
        if (discard(game, HUMAN, game.drawnTile!)) {
          sfx.discard()
          force()
        }
      }, CPU_DELAY_MS)
      return () => clearTimeout(id)
    }
  }, [game, tick, autoWin, noCall, autoTsumogiri, effect, announce, started])

  // CPUの手番を進める。開始前と演出中は止める。
  useEffect(() => {
    if (!started || game.phase === 'end' || effect) return

    if (game.phase === 'call') {
      const next = game.pendingCalls.find((c) => c.response === null && game.players[c.seat].isCpu)
      if (!next) return // 人間の応答待ち
      const id = setTimeout(() => {
        const r = cpuCallResponse(game, next.seat, next.options)
        const seat = next.seat
        respondCall(game, seat, r)
        if (r === 'ron') announce('ron', seat)
        else if (r === 'pon') announce('pon', seat)
        else if (r === 'minkan') announce('kan', seat)
        force()
      }, CPU_DELAY_MS)
      return () => clearTimeout(id)
    }

    if (!game.players[game.turn].isCpu) return
    const seat = game.turn
    const id = setTimeout(() => {
      const a = cpuTurnAction(game, seat)
      if (a.kind === 'tsumo') {
        declareTsumo(game, seat)
        announce('tsumo', seat)
      } else if (a.kind === 'kan') {
        declareSelfKan(game, seat, a.tile)
        announce('kan', seat)
      } else {
        discard(game, seat, a.tile, a.riichi)
        if (a.riichi) announce('riichi', seat)
        else sfx.discard()
      }
      force()
    }, CPU_DELAY_MS)
    return () => clearTimeout(id)
  }, [game, tick, effect, announce, started])

  const opts = turnOptions(game, HUMAN)
  const myCall = game.phase === 'call' ? game.pendingCalls.find((c) => c.seat === HUMAN) : undefined
  const [riichiArmed, setRiichiArmed] = useState(false)

  const onDiscard = (t: TileId) => {
    const withRiichi = riichiArmed && opts.riichiTiles.includes(t)
    if (riichiArmed && !withRiichi) return

    // タップ確認: 1回目は持ち上げるだけ。同じ牌をもう一度タップで確定。
    if (confirmTap && pending !== t) {
      setPending(t)
      return
    }

    if (discard(game, HUMAN, t, withRiichi)) {
      if (withRiichi) sfx.riichi()
      else sfx.discard()
      setRiichiArmed(false)
      setPending(null)
      force()
    }
  }


  return (
    <div className={`app back-${back}`}>
      {shrinkHint && <div className="fs-hint">▲ 画面を上にゆっくりスワイプするとツールバーが縮みます</div>}
      <header>
        {debug && <span className="dbg">デバッグ表示中 (jj で解除)</span>}
      </header>

      {(
        <>
          <div className="table-wrap">
            <div className={`table seats-${game.seatCount}`}>
              {/*
                タブは卓の右上に置く。パネルを開いている間は「閉じる」だけを出す。
                開いた先で他のタブを並べても、パネルに隠れて押せないため。
              */}
              <nav className="tabs">
                {tab !== 'table' ? (
                  <button className="tab on" onClick={() => setTab('table')}>
                    閉じる
                  </button>
                ) : (
                  <>
                    {supportsFullscreen() && (
                      <button className="tab" onClick={() => void toggleFullscreen()}>
                        {fs ? '⤢' : '⛶'}
                      </button>
                    )}
                    {(['rules', 'settings'] as const).map((t) => (
                      <button
                        key={t}
                        className="tab"
                        onClick={() => setTab(t)}
                        aria-label={t === 'rules' ? 'ルール' : '設定'}
                      >
                        {t === 'rules' ? 'ルール' : '⚙'}
                      </button>
                    ))}
                  </>
                )}
              </nav>

              {game.players.map((p, i) => (
                <SeatArea
                  key={i}
                  game={game}
                  player={p}
                  dir={dirs[i]}
                  chips={chips[i]}
                  points={points[i]}
                  stakes={stakes}
                  human={i === HUMAN}
                  debug={debug}
                  opts={i === HUMAN ? opts : undefined}
                  riichiArmed={i === HUMAN && riichiArmed}
                  pending={i === HUMAN ? pending : null}
                  onDiscard={onDiscard}
                />
              ))}

              <div className="pond">
                {game.players.map((p, i) => (
                  <div key={i} className={`pond-cell pc-${dirs[i]}`}>
                    <div className="pond-inner">
                      <Discards player={p} />
                    </div>
                  </div>
                ))}
                <div className="pond-center">
                  {/*
                   * 王牌8枚を実際の並びで見せる。
                   * 嶺上4枚 (カンで減る) / ドラ表示2枚 (表向き) / 裏ドラ表示2枚 (和了時のみ表)。
                   * 表示するのはドラそのものではなく「表示牌」。
                   */}
                  <DeadWall game={game} />
                  <div className="wall-count">
                    <span>残り</span>
                    <b>{wallRemaining(game)}</b>
                  </div>
                </div>
              </div>

              {/* 対局中に切り替えたい設定。卓の左下にプルダウンで畳む。 */}
              {started && (
                <details className="opt-menu">
                  <summary>設定</summary>
                  <div className="opt-menu-body">
                    <Toggle on={noCall} onClick={() => setNoCall((v) => !v)} label="鳴きなし" />
                    <Toggle on={autoWin} onClick={() => setAutoWin((v) => !v)} label="自動和了" />
                    <Toggle
                      on={autoTsumogiri}
                      onClick={() => setAutoTsumogiri((v) => !v)}
                      label="リーチ後ツモ切り"
                    />
                  </div>
                </details>
              )}

              {/* ルール・設定は卓の上にかぶせる */}
              {tab === 'rules' && (
                <div className="panel-overlay">
                  <RulesPanel rules={rules} stakes={stakes} seatCount={seatCount} />
                </div>
              )}
              {tab === 'settings' && (
                <div className="panel-overlay">
                  <SettingsPanel
                    seatCount={seatCount}
                    stakes={stakes}
                    debug={debug}
                    confirmTap={confirmTap}
                    onConfirmTap={(v) => {
                      setConfirmTap(v)
                      setPending(null)
                    }}
                    sound={sound}
                    onSound={setSound}
                    backSetting={backSetting}
                    onBackSetting={(v) => {
                      setBackSetting(v)
                      setBack(pickBackColor(v))
                    }}
                    onApply={(count, st) => {
                      setStakes(st)
                      resetTable(count, st)
                    }}
                  />
                </div>
              )}
              <div style={{ display: 'none' }}>
              </div>

              {/* 操作ボタンは卓の上に重ねる。卓の下に置くと画面外に出て気づけない。 */}
              <div className="actions">
              {started && game.turn === HUMAN && game.phase === 'discard' && (
                <>
                  {opts.canTsumo && (
                    <button className="hot" onClick={() => { declareTsumo(game, HUMAN); announce('tsumo', HUMAN); force() }}>
                      ツモ
                    </button>
                  )}
                  {/* リーチ中は「やめる」に変わる。ポン/パスと同じ操作バーの位置。 */}
                  {opts.riichiTiles.length > 0 && (
                    <button
                      className={riichiArmed ? 'pass' : 'call'}
                      onClick={() => setRiichiArmed((v) => !v)}
                    >
                      {riichiArmed ? 'やめる' : 'リーチ'}
                    </button>
                  )}
                  {opts.kanTiles.map((t) => (
                    <button key={t} className="call" onClick={() => { declareSelfKan(game, HUMAN, t); announce('kan', HUMAN); force() }}>
                      カン {tileName(t)}
                    </button>
                  ))}
                </>
              )}

              {started && myCall && myCall.response === null && (
                <>
                  {myCall.options.includes('ron') && (
                    <button className="hot" onClick={() => { respondCall(game, HUMAN, 'ron'); announce('ron', HUMAN); force() }}>
                      ロン
                    </button>
                  )}
                  {myCall.options.includes('pon') && (
                    <button className="call" onClick={() => { respondCall(game, HUMAN, 'pon'); announce('pon', HUMAN); force() }}>ポン</button>
                  )}
                  {myCall.options.includes('minkan') && (
                    <button className="call" onClick={() => { respondCall(game, HUMAN, 'minkan'); announce('kan', HUMAN); force() }}>カン</button>
                  )}
                  <button className="pass" onClick={() => { respondCall(game, HUMAN, 'pass'); force() }}>パス</button>
                </>
              )}
            </div>

            {/* 開始前。押されるまで配牌も進行も始めない。 */}
            {!started && (
              <div className="start-screen">
                <div className="start-logo">韓麻</div>
                <div className="start-sub">HANMA / 韓国式麻雀</div>

                <div className="start-seats">
                  {[4, 3].map((n) => (
                    <button
                      key={n}
                      className={`start-seat ${seatCount === n ? 'on' : ''}`}
                      onClick={() => setSeatCount(n)}
                    >
                      <b>{n}</b>
                      <span>人打ち</span>
                      <em>CPU {n - 1}人</em>
                    </button>
                  ))}
                </div>

                <button
                  className="start-btn"
                  onClick={() => {
                    // 音の解錠はユーザー操作の中でしかできない。
                    void unlockAudio()
                    setPoints(new Array(seatCount).fill(0))
                    setChips(new Array(seatCount).fill(stakes.startingChips))
                    setHouseRake(0)
                    setBack(pickBackColor(backSetting))
                    setGame(createGame({ seatCount, rules }))
                    setSettled(false)
                    setStarted(true)
                  }}
                >
                  開始
                </button>
                {stakes.rate > 0 && (
                  <div className="start-note">
                    1点 = {formatChips(stakes.rate)}W / レーキ {stakes.rakePercent}%
                  </div>
                )}
              </div>
            )}

            {effect && (
              <div className={`call-effect ef-${effect.dir} ef-${effect.kind}`}>
                <span>{effect.text}</span>
              </div>
            )}

            {/* 掛け声の演出が終わってから結果を出す */}
            {game.result && !effect && (
              <Result
                game={game}
                stakes={stakes}
                chips={chips}
                dirs={dirs}
                houseRake={houseRake}
                canContinue={canContinue}
                broke={broke}
                onNext={nextHand}
                onRebuy={() => resetTable(seatCount, stakes)}
              />
            )}
            </div>
          </div>

        </>
      )}
    </div>
  )
}

const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`)

const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button className={`toggle ${on ? 'on' : ''}`} onClick={onClick}>
    {label}
  </button>
)

/**
 * 王牌8枚 = 4列 × 2段の積み牌。
 *
 * 実物と同じく上から見た形にするので、見えるのは上段の4枚だけ。
 *   上段(見える): 嶺上 嶺上 ドラ表示 ドラ表示
 *   下段(隠れる): 嶺上 嶺上 裏ドラ  裏ドラ  ← ドラ表示牌の真下がその裏ドラ表示牌
 * 裏ドラは和了時に結果パネルで見せる。
 * 嶺上牌は左の列から順に取られ、1列(2枚)使い切ると空く。
 */
const DeadWall = ({ game }: { game: GameState }) => {
  const taken = game.rinshanTaken
  // 嶺上は左の列の上下2枚 → 右の列の上下2枚、の順に取る
  const colUsedUp = (col: number) => taken >= (col + 1) * 2
  return (
    <div className="dead-wall-box">
      <div className="dead-wall">
        {[0, 1].map((col) =>
          colUsedUp(col) ? (
            <span key={`r${col}`} className="rinshan-gap" />
          ) : (
            <span key={`r${col}`} className="dw-stack">
              <Tile back />
            </span>
          ),
        )}
        {game.doraIndicators.map((t, i) => (
          <span key={`d${i}`} className="dw-stack">
            <Tile tile={t} />
          </span>
        ))}
      </div>
    </div>
  )
}

/* ---------- 席 ---------- */

interface SeatProps {
  game: GameState
  player: Player
  dir: Dir
  chips: number
  points: number
  stakes: StakeSettings
  human: boolean
  debug: boolean
  opts?: ReturnType<typeof turnOptions>
  riichiArmed: boolean
  /** タップ確認で持ち上がっている牌。 */
  pending: TileId | null
  onDiscard: (t: TileId) => void
}

const SeatArea = ({ game, player, dir, chips, points, stakes, human, debug, opts, riichiArmed, pending, onDiscard }: SeatProps) => {
  const active = game.turn === player.seat && game.phase === 'discard'
  // 局が終わっても開けるのは和了者だけ。降りた他家の手牌は伏せたままにする。
  const reveal = human || debug || (game.phase === 'end' && game.result?.winner === player.seat)
  const myTurn = human && active

  // ツモ牌は手牌の末尾。表示上は本体と切り離し、専用の枠に置く。
  const hasDrawn = game.drawnTile !== null && game.turn === player.seat && player.hand.length > 0
  const body = hasDrawn ? player.hand.slice(0, -1) : player.hand
  const drawn = hasDrawn ? player.hand[player.hand.length - 1] : null
  const drawnPickable =
    drawn !== null &&
    !!opts &&
    myTurn &&
    opts.discardable.includes(drawn) &&
    (!riichiArmed || opts.riichiTiles.includes(drawn))

  return (
    <div className={`side side-${dir} ${active ? 'active' : ''}`}>
      {/* 席名と額は改行して2段にする (横に長いと河や卓を圧迫する) */}
      <div className="plate">
        <span className="plate-row">
          <strong>{seatName(player.seat, game.seatCount, game.dealer)}</strong>
          {game.dealer === player.seat && <span className="badge dealer">親</span>}
          {player.riichi && <span className="badge riichi">リーチ</span>}
        </span>
        {/* 名札には現在の持ち額だけを出す。累計の収支は結果パネルで見せる。 */}
        {stakes.rate > 0 ? (
          <span className="chips">{formatChips(chips)}W</span>
        ) : (
          <span className="pt">{fmt(points)}点</span>
        )}
      </div>

      <div className="rack">
        <Melds melds={player.melds} dir={dir} seat={player.seat} seatCount={game.seatCount} />
        <div className="hand">
          {body.map((t, i) => {
            const canPick = !!opts && myTurn && opts.discardable.includes(t) && (!riichiArmed || opts.riichiTiles.includes(t))
            return (
              <Tile
                key={i}
                tile={reveal ? t : undefined}
                back={!reveal}
                dir={dir}
                small={!human}
                selectable={canPick}
                // リーチ宣言牌は光らせる。これが無いと、どれを押せばいいのか分からない。
                pick={riichiArmed && canPick}
                armed={canPick && pending === t}
                dim={riichiArmed && !!opts && !opts.riichiTiles.includes(t)}
                onClick={canPick ? () => onDiscard(t) : undefined}
              />
            )
          })}
          {/*
           * ツモ牌の場所は常に確保しておく。無いときに詰めてしまうと、
           * ツモのたびに手牌全体が左右に動いて狙った牌を押しにくい。
           */}
          <span className={`tsumo-slot ${human ? 'big' : ''}`}>
            {drawn !== null && (
              <Tile
                tile={reveal ? drawn : undefined}
                back={!reveal}
                dir={dir}
                small={!human}
                selectable={drawnPickable}
                pick={riichiArmed && drawnPickable}
                armed={drawnPickable && pending === drawn}
                dim={riichiArmed && !!opts && !opts.riichiTiles.includes(drawn)}
                onClick={drawnPickable ? () => onDiscard(drawn) : undefined}
              />
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * 河。牌は正立で描き、席ごとの向きは .pond-inner のコンテナ回転に任せる。
 * ここで席の向きも指定すると二重に回ってしまう。
 */
const Discards = ({ player }: { player: Player }) => (
  <div className="discards">
    {player.discards.map((t, i) => (
      <Tile key={i} tile={t} small rotated={player.riichiTileIndex === i} />
    ))}
  </div>
)

/**
 * 鳴いた牌を横向きに置く位置。麻雀の慣習どおり、位置で「誰から鳴いたか」を示す。
 *   上家 → 左端 / 対面 → 中 / 下家 → 右端
 * 暗槓は誰からでもないので -1 (横向きなし)。
 */
const calledTileIndex = (m: Meld, seat: Seat, seatCount: number, n: number): number => {
  if (m.from === null) return -1
  const rel = (m.from - seat + seatCount) % seatCount
  if (rel === 1) return n - 1 // 下家 → 右端
  if (seatCount === 4 && rel === 2) return 1 // 対面 → 中
  return 0 // 上家 → 左端
}

const Melds = ({
  melds,
  dir,
  seat,
  seatCount,
}: {
  melds: Meld[]
  dir: Dir
  seat: Seat
  seatCount: number
}) => (
  <div className="melds">
    {melds.map((m, i) => {
      /*
       * 加槓はポンした3枚のまま。4枚目は新しく横に足すのではなく、
       * 鳴いた相手を示す「横向きの牌」に重ねて置くのが一般的な表示。
       */
      const stacked = m.kind === 'kakan'
      const n = m.kind === 'pon' || stacked ? 3 : 4
      const called = calledTileIndex(m, seat, seatCount, n)
      return (
        <span key={i} className="meld">
          {Array.from({ length: n }).map((_, j) => {
            // 暗槓は両端を伏せる。
            const hidden = m.kind === 'ankan' && (j === 0 || j === 3)
            if (stacked && j === called) {
              return (
                <span key={j} className="kakan">
                  <Tile tile={m.tile} dir={dir} small rotated />
                  <Tile tile={m.tile} dir={dir} small rotated />
                </span>
              )
            }
            return (
              <Tile
                key={j}
                tile={hidden ? undefined : m.tile}
                back={hidden}
                dir={dir}
                small
                rotated={j === called}
              />
            )
          })}
        </span>
      )
    })}
  </div>
)

/* ---------- 結果 ---------- */

/**
 * 局の結果。天鳳の点数表示に倣った構成にしている。
 *   1. 和了形
 *   2. 大きな見出し (天鳳の「30符3飜 1000-2000点」に相当)
 *   3. 内訳の2列リスト (天鳳の役一覧の位置)
 *   4. 各家の「持ち点 と 増減」
 * 韓麻には符も飜も役も無いので、2 と 3 はロン/ツモ・リーチ・ドラで置き換える。
 */
const Result = ({
  game,
  stakes,
  chips,
  dirs,
  houseRake,
  canContinue,
  broke,
  onNext,
  onRebuy,
}: {
  game: GameState
  stakes: StakeSettings
  chips: number[]
  /** 席を画面のどの辺に置くか。点数授受を卓と同じ配置で見せるのに使う。 */
  dirs: Dir[]
  houseRake: number
  canContinue: boolean
  broke: number[]
  onNext: () => void
  onRebuy: () => void
}) => {
  const r = game.result!
  const { chipDeltas, rake } = settle(r.deltas, stakes)
  const winner = r.winner === null ? null : game.players[r.winner]
  const sc = r.score

  return (
    <div className="result">
      {winner === null ? (
        <div className="headline draw">流局</div>
      ) : (
        <>
          <div className="win-hand">
            {/* 鳴いた牌の向きは卓上と同じにする (どこから鳴いたかが分かる) */}
            <Melds melds={winner.melds} dir="bottom" seat={winner.seat} seatCount={game.seatCount} />
            <span className="concealed">
              {[...winner.hand].sort((a, b) => a - b).map((t, i) => (
                <Tile key={i} tile={t} small />
              ))}
              {r.reason === 'ron' && r.winningTile !== null && (
                <span className="agari-tile">
                  <Tile tile={r.winningTile} small />
                </span>
              )}
            </span>
          </div>

          {/* 天鳳の「◯符◯飜 ◯点」にあたる大見出し */}
          <div className="headline">
            <span className="who">{seatName(r.winner!, game.seatCount, game.dealer)}</span>
            <span className="how">{r.reason === 'tsumo' ? 'ツモ' : 'ロン'}</span>
            {r.reason === 'tsumo' ? (
              <span className="pts">
                {sc!.perPayer}点オール<em>計 {sc!.total}点</em>
              </span>
            ) : (
              <span className="pts">
                {sc!.total}点<em>放銃 {seatName(r.loser!, game.seatCount, game.dealer)}</em>
              </span>
            )}
          </div>

          {/* 天鳳の役一覧の位置。韓麻は役が無いので加点の内訳を並べる。 */}
          <div className="parts">
            {r.shape === 'chiitoitsu' && (
              <div className="p"><span className="k">七対子</span><span className="v">形</span></div>
            )}
            {r.shape === 'kokushi' && (
              <div className="p"><span className="k">国士無双</span><span className="v">役満</span></div>
            )}
            {sc!.parts.map((p, i) => (
              <div key={i} className="p">
                <span className="k">
                  {p.label}
                  {p.count !== undefined && <em>×{p.count}</em>}
                </span>
                <span className="v">{p.points}点</span>
              </div>
            ))}
          </div>
          {sc!.capped && <div className="capped">1人{game.rules.maxPaymentPerPlayer}点の上限を適用しました</div>}
        </>
      )}

      {/*
       * ドラは卓中央に出しているが、結果パネルがそこを覆ってしまうため
       * 何がドラだったかを確認できない。パネル内にも並べる。
       */}
      <div className="dora-row">
        <span className="cap">ドラ表示</span>
        {game.doraIndicators.map((t, i) => (
          <Tile key={i} tile={t} small />
        ))}
        {r.uraIndicators.length > 0 && (
          <>
            <span className="cap ura">裏ドラ表示</span>
            {r.uraIndicators.map((t, i) => (
              <Tile key={`u${i}`} tile={t} small />
            ))}
          </>
        )}
      </div>

      {/*
       * 点数の授受は、卓の席と同じ配置で見せる。
       * 表で縦に並べるより、誰が誰に払ったのかが直感的に分かる。
       */}
      <div className={`ledger-seats seats-${game.seatCount}`}>
        {r.deltas.map((d, i) => (
          <div
            key={i}
            className={`lseat l-${dirs[i]} ${d > 0 ? 'plus' : d < 0 ? 'minus' : 'zero'}`}
          >
            <span className="n">
              {seatName(i, game.seatCount, game.dealer)}
              {game.dealer === i && <span className="badge dealer">親</span>}
            </span>
            {/*
              席ごとの表示はWだけにする。点は上の見出しと下の内訳に出ているので、
              ここに並べても同じ数字が3か所に散るだけで読みにくい。
              (レートを0にするとWが動かないので、そのときだけ点に戻す)
            */}
            {stakes.rate > 0 ? (
              <span className="c">
                {formatChips(chips[i])}W
                {d !== 0 && <em>{fmt(chipDeltas[i])}W</em>}
              </span>
            ) : (
              <span className="p">{d === 0 ? '±0' : `${fmt(d)}点`}</span>
            )}
          </div>
        ))}
      </div>

      {stakes.rate > 0 && rake > 0 && (
        <div className="rake">
          レーキ {stakes.rakePercent}% → ハウス <b>{formatChips(rake)}W</b>
          <span className="cum">(累計 {formatChips(houseRake)}W)</span>
        </div>
      )}

      {canContinue ? (
        <button className="hot big" onClick={onNext}>
          次の局へ
        </button>
      ) : (
        <div className="broke">
          <span>
            {broke.map((i) => seatName(i, game.seatCount, game.dealer)).join('・')} がデポジット
            {formatChips(stakes.deposit)}W を払えないため続行できません。
          </span>
          <button className="hot" onClick={onRebuy}>
            W を買い直して再開
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- 設定 ---------- */

const SettingsPanel = ({
  seatCount,
  stakes,
  debug,
  confirmTap,
  onConfirmTap,
  sound,
  onSound,
  backSetting,
  onBackSetting,
  onApply,
}: {
  seatCount: number
  stakes: StakeSettings
  debug: boolean
  confirmTap: boolean
  onConfirmTap: (v: boolean) => void
  sound: boolean
  onSound: (v: boolean) => void
  backSetting: BackColorSetting
  onBackSetting: (v: BackColorSetting) => void
  onApply: (count: number, st: StakeSettings) => void
}) => {
  const [count, setCount] = useState(seatCount)
  const [st, setSt] = useState(stakes)
  // 打牌方法はタッチ端末でしか意味が無いので、マウス環境では出さない。
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  const set = <K extends keyof StakeSettings>(k: K, v: StakeSettings[K]) => setSt((s) => ({ ...s, [k]: v }))

  return (
    <div className="settings">
      <h3>人数</h3>
      <div className="seg">
        {[4, 3].map((n) => (
          <button key={n} className={count === n ? 'on' : ''} onClick={() => setCount(n)}>
            {n}人打ち
          </button>
        ))}
      </div>

      <h3>レーキ</h3>
      <div className="seg">
        {RAKE_CHOICES.map((r) => (
          <button
            key={r}
            className={st.rakePercent === r ? 'on' : ''}
            onClick={() => set('rakePercent', r)}
          >
            {r}%
          </button>
        ))}
      </div>

      <h3>効果音</h3>
      <div className="seg">
        <button className={sound ? 'on' : ''} onClick={() => onSound(true)}>あり</button>
        <button className={!sound ? 'on' : ''} onClick={() => onSound(false)}>なし</button>
      </div>

      {touch && (
        <>
          <h3>打牌</h3>
          <div className="seg">
            <button className={!confirmTap ? 'on' : ''} onClick={() => onConfirmTap(false)}>
              シングルタップ
            </button>
            <button className={confirmTap ? 'on' : ''} onClick={() => onConfirmTap(true)}>
              ダブルタップ
            </button>
          </div>
        </>
      )}

      <h3>牌の背の色</h3>
      <div className="seg">
        <button className={backSetting === 'random' ? 'on' : ''} onClick={() => onBackSetting('random')}>
          ランダム
        </button>
        {BACK_COLORS.map((c) => (
          <button
            key={c.id}
            className={`back-pick back-${c.id} ${backSetting === c.id ? 'on' : ''}`}
            onClick={() => onBackSetting(c.id)}
          >
            <span className="swatch" />
            {c.label}
          </button>
        ))}
      </div>

      {/*
        開始スタックとデポジットは通常は固定 (デポジット = 20点)。
        動作確認のためだけに、デバッグ表示中 (jj) のときだけ手で変えられるようにする。
      */}
      {debug && (
        <>
          <h3>デバッグ: スタック / デポジット</h3>
          <div className="fields">
            <label>
              レート (1点あたりの W)
              <input type="number" min={0} step={10} value={st.rate} onChange={(e) => set('rate', Math.max(0, Number(e.target.value)))} />
            </label>
            <label>
              デポジット (局開始に必要)
              <input type="number" min={0} step={100} value={st.deposit} onChange={(e) => set('deposit', Math.max(0, Number(e.target.value)))} />
            </label>
            <label>
              開始額 (W)
              <input type="number" min={0} step={1000} value={st.startingChips} onChange={(e) => set('startingChips', Math.max(0, Number(e.target.value)))} />
            </label>
          </div>
        </>
      )}

      <div className="apply">
        <button className="hot" onClick={() => onApply(count, st)}>
          この設定で卓を立て直す
        </button>
      </div>
    </div>
  )
}
