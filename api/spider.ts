/* eslint camelcase: ["off"] */
import { APIResults, MusicData, MusicCore, RankCore, PlayerValue } from './type.js'
import { rank, player, search } from './database.js'
import { PARALLEL } from './config.js'

import { musics } from './albumParser.js'

import got from 'got'

import { log, error, reloadAlbums } from './api.js'

import { download, resultWithHistory, makeSearch } from './common.js'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const parallel = async <T>(n: number, pfs: (() => Promise<(number) => T>)[]) => {
  const ws = new Set<() => Promise<(number) => T>>()
  const ps: Promise<T>[] = []
  const epfs = pfs.map(w => async () => {
    ws.add(w)
    const l = await w()
    ws.delete(w)
    const result = l(ws.size + epfs.length)
    if (ws.size < n && epfs.length) {
      const p = epfs.shift()()
      ps.push(p)
      await p
    }
    return result
  })
  for (let i = 0; i < n && epfs.length; i++) {
    ps.push(epfs.shift()())
  }
  await Promise.all(ps)
  return Promise.all(ps)
}

const platforms = {
  mobile: 'leaderboard',
  pc: 'pcleaderboard'
} as const

const downloadCore = ({ api, uid, difficulty }) => async (): Promise<APIResults | void> => (await got(`https://prpr-muse-dash.leanapp.cn/musedash/v1/${api}/top?music_uid=${uid}&music_difficulty=${difficulty + 1}&limit=1999`, { timeout: 1000 * 60 * 10 }).json() as any).result

const core = ({ uid, difficulty, platform, api }: RankCore) => async () => {
  const result = await download({ s: `${uid} - ${difficulty} - ${api}`, error, f: downloadCore({ uid, difficulty, api }) })

  if (result) {
    const current = (await rank.get({ uid, difficulty, platform }) || [])

    await rank.put({ uid, difficulty, platform, value: resultWithHistory({ result, current }) })
  }
}

const sum = async ({ uid, difficulty }: MusicCore) => {
  const [currentRank, result] = [await rank.get({ uid, difficulty, platform: 'all' }), (await Promise.all(Object.keys(platforms).map(async platform => (await rank.get({ uid, difficulty, platform })).map(play => ({ ...play, platform })))))
    .flat()
    .sort((a, b) => b.play.score - a.play.score)]
  if (currentRank) {
    for (let i = 0; i < result.length; i++) {
      result[i].history = { lastRank: currentRank.findIndex(play => play.platform === result[i].platform && play.user.user_id === result[i].user.user_id) }
    }
  }
  return rank.put({ uid, difficulty, platform: 'all', value: result })
}

const prepare = (music: MusicData) => {
  const { uid, difficulty: difficulties, name } = music
  const dfs = difficulties.map((difficultyNum, difficulty) => {
    if (difficultyNum !== '0') {
      const musicData = Object.entries(platforms)
        .map(([platform, api]) => ({ uid, difficulty, api, platform }))
      return () => Promise.all(musicData.map(core).map(w => w()))
        .then(() => sum({ uid, difficulty }))
        .then(() => musicData)
    }
  }).filter(Boolean)
  return () => Promise.all(dfs.map(w => w())).then(datas => (i: number) => {
    log(`${uid}: ${name} / ${i}`)
    return datas.flat() as RankCore[]
  })
}

const analyze = (musicList: RankCore[]) => musicList
  .reduce(async (p, { uid, difficulty, platform }) => {
    await p
    const currentRank = await rank.get({ uid, difficulty, platform })
    const sumRank = await rank.get({ uid, difficulty, platform: 'all' })
    return (await currentRank
      .map(async ({ user, play: { score, acc, character_uid, elfin_uid }, history }, i) => {
        let playerData = await player.get(user.user_id).catch(() => ({ plays: [] }) as PlayerValue)
        playerData.user = user
        const sumI = sumRank.findIndex(play => play.platform === platform && play.user.user_id === user.user_id)
        playerData.plays.push({ score, acc, i, platform, history, difficulty, uid, sum: sumI, character_uid, elfin_uid })
        return { key: user.user_id, value: playerData }
      })
      .reduce(async (b, v: Promise<{ key: string, value: PlayerValue }>) => {
        const { key, value } = await v
        const batch = await b
        return batch.put(key, value)
      }, Promise.resolve(player.batch())))
      .write().then(() => undefined)
  }, player.clear())

const mal = async () => {
  log('Start!')
  const musicList = await musics()
  const pfs = musicList.map(prepare)
  const datass = await parallel(PARALLEL, pfs)
  log('Downloaded')
  await analyze(datass.flat())
  log('Analyzed')
  await makeSearch({ log, player, search })
  log('Search Cached')
  await reloadAlbums()
}

export const run = async () => {
  log('hi~')
  await mal()
  while (true) {
    const currentHour = new Date().getUTCHours()
    const waitTime = (19 - currentHour + 24) % 24 || 24
    log(`WAIT: ${waitTime}h`)
    await wait(waitTime * 60 * 60 * 1000)
    const startTime = Date.now()
    await mal()
    const endTime = Date.now()
    log(`TAKE ${endTime - startTime}, at ${new Date().toString()}`)
  }
}
