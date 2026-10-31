import liveGame from './human-win-2026-10-30.json';
import missedWhiteWin from './missed-white-win-g10.json';
import { emptyPosition, play, type Point } from '../../src/business/rules';

export const point = (text: string): Point => ({ x: text.charCodeAt(0) - 65, y: 15 - Number(text.slice(1)) });
export const humanWinCase = liveGame;
export const humanWinPosition = () => liveGame.moves.reduce((position, text) => play(position, point(text)), emptyPosition());
export const missedWhiteWinCase = missedWhiteWin;
export const missedWhiteWinPosition = () => missedWhiteWin.moves.reduce((position, text) => play(position, point(text)), emptyPosition());
