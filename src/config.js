export const PLAYER_HEIGHT = 1.6; // 視点の高さ（地面からの目線の高さ）
export const PLAYER_RADIUS = 0.6; // プレイヤーの当たり半径（XZ平面）

// 都市（木=直方体）の配置パラメータ
export const CITY_EXTENT = 300;           // 都市生成半径（XZの±範囲）
export const CITY_SPACING = 36;           // グリッド間隔（やや狭め）
export const TREE_JITTER_FACTOR = 0.3;    // グリッドからのオフセット比率
export const TREE_BASE_THICKNESS = 10;    // 樹（直方体）太さの基準
export const TREE_THICKNESS_VARIANCE = 2; // 太さの±ランダム幅

// ロボット配置（仕様書の推奨座標）
export const ROBOT_SPAWNS = [
  { x: -220, z: -220 },
  { x: 0,    z: 260  },
  { x: 260,  z: 20   }
];

// ロボット寸法（仕様の基準値）
export const ROBOT_DIM = {
  torso: 28,                      // 胴体の立方体一辺（小型化）
  head: 12,                       // 頭の立方体一辺（小型化）
  arm: { w: 8, h: 18, d: 8 },     // 腕の寸法（小型化）
  armHeightRatio: 0.6,            // 腕の取付高さ（胴体高さに対する比）
  reserveMargin: 60               // 予約領域の余白
};
