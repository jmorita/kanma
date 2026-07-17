import { tileName, type Tile as TileId } from '../core/tiles'
import { tileImage } from './tileImage'

/** 卓のどちら側の席の牌か。その席から見て正立するよう回転させる。 */
export type Dir = 'bottom' | 'right' | 'top' | 'left'

const ROT: Record<Dir, number> = { bottom: 0, right: -90, top: 180, left: 90 }

interface Props {
  tile?: TileId
  dir?: Dir
  /** 伏せ牌 (他家の手牌・暗槓の両端)。 */
  back?: boolean
  small?: boolean
  /** リーチ宣言牌。席の向きからさらに90度倒す。 */
  rotated?: boolean
  onClick?: () => void
  selectable?: boolean
  dim?: boolean
  /** リーチ宣言牌の候補。光らせて選ぶべき牌を示す。 */
  pick?: boolean
  /** タップ確認で持ち上がっている牌 (もう一度押すと切れる)。 */
  armed?: boolean
  /** ツモってきた牌。少し離して置く。 */
  drawn?: boolean
  /** 河のツモ切り牌。少しくすませて手出しと見分ける。 */
  tsumogiri?: boolean
}

export const Tile = ({
  tile,
  dir = 'bottom',
  back,
  small,
  rotated,
  onClick,
  selectable,
  dim,
  pick,
  armed,
  drawn,
  tsumogiri,
}: Props) => {
  // 席の向きとリーチ宣言牌の横倒しを合成した最終的な角度。
  const deg = ROT[dir] + (rotated ? 90 : 0)
  // 90/270度なら牌の外形が縦横入れ替わるので、占める場所も入れ替える。
  const swapped = (((deg % 180) + 180) % 180) === 90

  const cls = [
    'tile',
    small ? 'is-sm' : '',
    swapped ? 'is-swap' : '',
    selectable ? 'is-sel' : '',
    dim ? 'is-dim' : '',
    pick ? 'is-pick' : '',
    armed ? 'is-armed' : '',
    drawn ? 'is-drawn' : '',
    tsumogiri ? 'is-tsumogiri' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={cls}
      // 牌の絵柄はSVGなので、外から牌種を識別できるよう属性で持たせる。
      data-tile={tile === undefined || back ? undefined : tile}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      <span className="tile-inner" style={{ transform: `translate(-50%, -50%) rotate(${deg}deg)` }}>
        {back || tile === undefined ? (
          <span className="tile-back" />
        ) : (
          <img className="tile-front" src={tileImage(tile)} alt={tileName(tile)} draggable={false} />
        )}
      </span>
    </span>
  )
}
