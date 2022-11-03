import { EDITOR, TEST } from 'internal:constants';
import {
    ConfigOrientation,
    IScreenOptions,
    SafeAreaEdge,
} from 'pal/screen-adapter';
import { systemInfo } from 'pal/system-info';
import { warnID } from '../../../cocos/core/platform/debug';
import { EventTarget } from '../../../cocos/core/event/event-target';
import { Size } from '../../../cocos/core/math';
import { Orientation } from '../enum-type';
import legacyCC from '../../../predefine';

interface ICachedStyle {
    width: string;
    height: string;
}

const EVENT_TIMEOUT = EDITOR ? 5 : 2;
const orientationMap: Record<ConfigOrientation, Orientation> = {
    auto: Orientation.AUTO,
    landscape: Orientation.LANDSCAPE,
    portrait: Orientation.PORTRAIT,
};

/**
 * On Web platform, the game window may points to different type of window.
 */
enum WindowType {
    /**
     * Unknown window type.
     */
    Unknown,
    /**
     * A SubFrame in BrowserWindow.
     * Need to set the frame size from an external editor option.
     * Should only dispatch 'resize' event when the frame size changed.
     * Setting window size is supported.
     */
    SubFrame,
    /**
     * The window size is determined by the size of BrowserWindow.
     * Should dispatch 'resize' event when the BrowserWindow size changed.
     * Setting window size is NOT supported.
     */
    BrowserWindow,
    /**
     * The window size is equal to the size of screen.
     * Should dispatch 'resize' event when enter / exit fullscreen or screen resize.
     * Setting window size is NOT supported.
     */
    Fullscreen,
}

interface IScreenFunctionName {
    requestFullscreen: string;
    exitFullscreen: string;
    fullscreenchange: string;
    fullscreenEnabled: string;
    fullscreenElement: string;
    fullscreenerror: string;
}

class ScreenAdapter extends EventTarget {
    public isFrameRotated = false;
    public handleResizeEvent = true;

    public get supportFullScreen (): boolean {
        return this._supportFullScreen;
    }
    public get isFullScreen (): boolean {
        if (!this._supportFullScreen) {
            return false;
        }
        return !!document[this._fn.fullscreenElement];
    }

    public get devicePixelRatio () {
        // TODO: remove the down sampling operation in DPR after supporting resolutionScale
        return Math.min(window.devicePixelRatio ?? 1, 2);
    }

    public get windowSize (): Size {
        const result = this._windowSizeInCssPixels;
        const dpr = this.devicePixelRatio;
        result.width *= dpr;
        result.height *= dpr;
        return result;
    }
    public set windowSize (size: Size) {
        if (this._windowType !== WindowType.SubFrame) {
            warnID(9202);
            return;
        }
        const css = this._convertToSizeInCssPixels(size);
        // console.log(
        //     `screen adapter set windowSize: ${size.toString()} vs css ${css.toString()} dpr ${
        //         this.devicePixelRatio
        //     }`
        // );
        this._resizeFrame(css);
    }

    public get resolution () {
        const windowSize = this.windowSize;
        const resolutionScale = this.resolutionScale;
        return new Size(
            windowSize.width * resolutionScale,
            windowSize.height * resolutionScale,
        );
    }
    public get resolutionScale () {
        return this._resolutionScale;
    }
    public set resolutionScale (v: number) {
        if (v === this._resolutionScale) {
            return;
        }
        //console.log(`screen adapter set resolutionScale: ${v}`);

        this._resolutionScale = v;
        this._cbToUpdateFrameBuffer?.();
    }

    public get orientation (): Orientation {
        return this._orientation;
    }
    public set orientation (value: Orientation) {
        if (this._orientation === value) {
            // console.log(
            //     `screen adapter set orientation -- same: ${
            //         value === Orientation.PORTRAIT ? "portrait" : "landscape"
            //     }`
            // );
            return;
        }
        // console.log(
        //     `screen adapter set orientation -- new: ${
        //         value === Orientation.PORTRAIT ? "portrait" : "landscape"
        //     }`
        // );
        this._orientation = value;
        this._updateFrameState();
    }

    public get safeAreaEdge (): SafeAreaEdge {
        return {
            top: parseInt(
                window
                    .getComputedStyle(document.documentElement)
                    .getPropertyValue('--safe-area-top'),
                10,
            ) * this.devicePixelRatio || 0,
            bottom: parseInt(
                window
                    .getComputedStyle(document.documentElement)
                    .getPropertyValue('--safe-area-bottom'),
                10,
            ) * this.devicePixelRatio || 0,
            left: parseInt(
                window
                    .getComputedStyle(document.documentElement)
                    .getPropertyValue('--safe-area-left'),
                10,
            ) * this.devicePixelRatio || 0,
            right: parseInt(
                window
                    .getComputedStyle(document.documentElement)
                    .getPropertyValue('--safe-area-right'),
                10,
            ) * this.devicePixelRatio || 0,
        };
    }
    public get isProportionalToFrame (): boolean {
        return this._isProportionalToFrame;
    }
    public set isProportionalToFrame (v: boolean) {
        if (this._isProportionalToFrame === v) {
            return;
        }
        this._isProportionalToFrame = v;
        this._updateContainer();
    }

    private _gameFrame?: HTMLDivElement;
    private _gameContainer?: HTMLDivElement;
    private _gameCanvas?: HTMLCanvasElement;
    private _isProportionalToFrame = false;
    private _cachedFrameStyle: ICachedStyle = { width: '0px', height: '0px' };
    private _cachedContainerStyle: ICachedStyle = {
        width: '0px',
        height: '0px',
    };
    private _cbToUpdateFrameBuffer?: () => void;
    private _supportFullScreen = false;
    private _touchEventName: string;
    private _onFullscreenChange?: () => void;
    private _onFullscreenError?: () => void;
    // We need to set timeout to handle screen event.
    private _orientationChangeTimeoutId = -1;
    private _cachedFrameSize = new Size(0, 0); // cache before enter fullscreen.
    private _exactFitScreen = false;
    private _fn = {} as IScreenFunctionName;
    // Function mapping for cross browser support
    private _fnGroup = [
        [
            'requestFullscreen',
            'exitFullscreen',
            'fullscreenchange',
            'fullscreenEnabled',
            'fullscreenElement',
            'fullscreenerror',
        ],
        [
            'requestFullScreen',
            'exitFullScreen',
            'fullScreenchange',
            'fullScreenEnabled',
            'fullScreenElement',
            'fullscreenerror',
        ],
        [
            'webkitRequestFullScreen',
            'webkitCancelFullScreen',
            'webkitfullscreenchange',
            'webkitIsFullScreen',
            'webkitCurrentFullScreenElement',
            'webkitfullscreenerror',
        ],
        [
            'mozRequestFullScreen',
            'mozCancelFullScreen',
            'mozfullscreenchange',
            'mozFullScreen',
            'mozFullScreenElement',
            'mozfullscreenerror',
        ],
        [
            'msRequestFullscreen',
            'msExitFullscreen',
            'MSFullscreenChange',
            'msFullscreenEnabled',
            'msFullscreenElement',
            'msfullscreenerror',
        ],
    ];
    private get _windowSizeInCssPixels () {
        if (TEST) {
            return new Size(window.innerWidth, window.innerHeight);
        }
        if (this.isProportionalToFrame) {
            if (!this._gameContainer) {
                warnID(9201);
                return new Size(0, 0);
            }
            return new Size(
                this._gameContainer.clientWidth,
                this._gameContainer.clientHeight,
            );
        }
        let fullscreenTarget;
        let width: number;
        let height: number;
        switch (this._windowType) {
        case WindowType.SubFrame:
            if (!this._gameFrame) {
                warnID(9201);
                return new Size(0, 0);
            }
            return new Size(
                this._gameFrame.clientWidth,
                this._gameFrame.clientHeight,
            );
        case WindowType.Fullscreen:
            fullscreenTarget = this._getFullscreenTarget()!;
            width = this.isFrameRotated
                ? fullscreenTarget.clientHeight
                : fullscreenTarget.clientWidth;
            height = this.isFrameRotated
                ? fullscreenTarget.clientWidth
                : fullscreenTarget.clientHeight;
            return new Size(width, height);
        case WindowType.BrowserWindow:
            width = this.isFrameRotated
                ? window.innerHeight
                : window.innerWidth;
            height = this.isFrameRotated
                ? window.innerWidth
                : window.innerHeight;
            return new Size(width, height);
        case WindowType.Unknown:
        default:
            return new Size(0, 0);
        }
    }
    private get _windowType (): WindowType {
        if (this.isFullScreen) {
            return WindowType.Fullscreen;
        }
        if (!this._gameFrame) {
            warnID(9201);
            return WindowType.Unknown;
        }
        if (this._exactFitScreen) {
            // Note: It doesn't work well to determine whether the frame exact fits the screen.
            // Need to specify the attribute from Editor.
            return WindowType.BrowserWindow;
        }
        return WindowType.SubFrame;
    }
    private _resolutionScale = 1;
    private _orientation = Orientation.AUTO;

    constructor () {
        super();
        // TODO: need to access frame from 'pal/launcher' module
        this._gameFrame = document.getElementById('GameDiv') as HTMLDivElement;
        this._gameContainer = document.getElementById(
            'Cocos3dGameContainer',
        ) as HTMLDivElement;
        this._gameCanvas = document.getElementById(
            'GameCanvas',
        ) as HTMLCanvasElement;
        // Compability with old preview or build template in Editor.
        if (!TEST && !EDITOR) {
            if (!this._gameFrame) {
                this._gameFrame = document.createElement<'div'>('div');
                this._gameFrame.setAttribute('id', 'GameDiv');
                this._gameCanvas?.parentNode?.insertBefore(
                    this._gameFrame,
                    this._gameCanvas,
                );
                this._gameFrame.appendChild(this._gameCanvas);
            }
            if (!this._gameContainer) {
                this._gameContainer = document.createElement<'div'>('div');
                this._gameContainer.setAttribute('id', 'Cocos3dGameContainer');
                this._gameCanvas?.parentNode?.insertBefore(
                    this._gameContainer,
                    this._gameCanvas,
                );
                this._gameContainer.appendChild(this._gameCanvas);
            }
        }

        let fnList: Array<string>;
        const fnGroup = this._fnGroup;
        for (let i = 0; i < fnGroup.length; i++) {
            fnList = fnGroup[i];
            // detect event support
            if (typeof document[fnList[1]] !== 'undefined') {
                for (let i = 0; i < fnList.length; i++) {
                    this._fn[fnGroup[0][i]] = fnList[i];
                }
                break;
            }
        }

        this._supportFullScreen = this._fn.requestFullscreen !== undefined;
        this._touchEventName =            'ontouchstart' in window ? 'touchend' : 'mousedown';
        this._registerEvent();
    }

    public init (options: IScreenOptions, cbToRebuildFrameBuffer: () => void) {
        this._cbToUpdateFrameBuffer = cbToRebuildFrameBuffer;
        this.orientation = orientationMap[options.configOrientation];
        this._exactFitScreen = options.exactFitScreen;

        // console.log(
        //     `screen adapter init -- orientation ${
        //         this.orientation === Orientation.PORTRAIT
        //             ? "portrait"
        //             : "landscape"
        //     }  exact fit: ${this._exactFitScreen}`
        // );
        this._resizeFrame();
    }

    public requestFullScreen (): Promise<void> {
        //console.log(`screen adapter request full screen`);
        return new Promise((resolve, reject) => {
            if (this.isFullScreen) {
                resolve();
                return;
            }
            this._cachedFrameSize = this.windowSize;
            this._doRequestFullScreen()
                .then(() => {
                    resolve();
                })
                .catch(() => {
                    const fullscreenTarget = this._getFullscreenTarget();
                    if (!fullscreenTarget) {
                        reject(new Error('Cannot access fullscreen target'));
                        return;
                    }
                    fullscreenTarget.addEventListener(
                        this._touchEventName,
                        () => {
                            this._doRequestFullScreen()
                                .then(() => {
                                    resolve();
                                })
                                .catch(reject);
                        },
                        { once: true, capture: true },
                    );
                });
        });
    }
    public exitFullScreen (): Promise<void> {
        //console.log(`screen adapter exit full screen`);
        return new Promise((resolve, reject) => {
            const requestPromise = document[this._fn.exitFullscreen]();
            if (window.Promise && requestPromise instanceof Promise) {
                requestPromise
                    .then(() => {
                        this.windowSize = this._cachedFrameSize;
                        resolve();
                    })
                    .catch(reject);
                return;
            }
            this.windowSize = this._cachedFrameSize;
            resolve();
        });
    }

    private _registerEvent () {
        document.addEventListener(this._fn.fullscreenerror, () => {
            this._onFullscreenError?.();
        });

        window.addEventListener('resize', () => {
            //console.log(`screen adapter resize event`);
            if (!this.handleResizeEvent) {
                return;
            }
            this._resizeFrame();
        });
        if (typeof window.matchMedia === 'function') {
            const updateDPRChangeListener = () => {
                const dpr = window.devicePixelRatio;
                // NOTE: some browsers especially on iPhone doesn't support MediaQueryList
                window
                    .matchMedia(`(resolution: ${dpr}dppx)`)
                    ?.addEventListener?.(
                        'change',
                        () => {
                            this.emit('window-resize');
                            updateDPRChangeListener();
                        },
                        { once: true },
                    );
            };
            updateDPRChangeListener();
        }
        window.addEventListener('orientationchange', () => {
            //console.log(`screen adapter orientation change event`);
            if (this._orientationChangeTimeoutId !== -1) {
                clearTimeout(this._orientationChangeTimeoutId);
            }
            this._orientationChangeTimeoutId = setTimeout(() => {
                //console.log(`screen adapter perform orientation change event`);
                if (!this.handleResizeEvent) {
                    return;
                }
                this._updateFrameState();
                this._resizeFrame();
                this.emit('orientation-change');
                this._orientationChangeTimeoutId = -1;
            }, EVENT_TIMEOUT);
        });

        document.addEventListener(this._fn.fullscreenchange, () => {
            //console.log(`screen adapter on fullscreen change event`);
            this._onFullscreenChange?.();
            this.emit('fullscreen-change');
        });
    }
    private _convertToSizeInCssPixels (size: Size) {
        const clonedSize = size.clone();
        const dpr = this.devicePixelRatio;
        clonedSize.width /= dpr;
        clonedSize.height /= dpr;
        return clonedSize;
    }

    private getWindowType (): string {
        switch (this._windowType) {
        case WindowType.SubFrame:
            return 'SubFrame';
        case WindowType.BrowserWindow:
            return 'BrowserWindow';
        case WindowType.Fullscreen:
            return 'Fullscreen';
        default:
            break;
        }
        return 'Unknown';
    }
    /**
     * The frame size may be from screen size or an external editor options by setting screen.windowSize.
     * @param sizeInCssPixels you need to specify this size when the windowType is SubFrame.
     */
    private _resizeFrame (sizeInCssPixels?: Size) {
        if (!this._gameFrame) {
            return;
        }

        const fullscreenTarget = this._getFullscreenTarget();
        // console.log(
        //     `screen adapater resizeFrame - window.innerWidth: [${
        //         window.innerWidth
        //     }] window.innerHeight:[${
        //         window.innerHeight
        //     }] this._windowType: [${this.getWindowType()}]
        //     fullscreen client w,h [${fullscreenTarget?.clientWidth},${
        //         fullscreenTarget?.clientHeight
        //     }]`
        // );
        // Center align the canvas
        this._gameFrame.style.display = 'flex';
        this._gameFrame.style['justify-content'] = 'center';
        this._gameFrame.style['align-items'] = 'center';
        if (this._windowType === WindowType.SubFrame) {
            if (!sizeInCssPixels) {
                this._updateContainer();
                return;
            }
            this._gameFrame.style.width = `${sizeInCssPixels.width}px`;
            this._gameFrame.style.height = `${sizeInCssPixels.height}px`;
        } else {
            const winWidth = window.innerWidth;
            const winHeight = window.innerHeight;
            if (this.isFrameRotated) {
                // console.log(
                //     `screen adapter resizeFrame - isFrameRotated: [${this.isFrameRotated}] - setting rotate(90deg)`
                // );
                this._gameFrame.style['-webkit-transform'] = 'rotate(90deg)';
                this._gameFrame.style.transform = 'rotate(90deg)';
                this._gameFrame.style['-webkit-transform-origin'] =                    '0px 0px 0px';
                this._gameFrame.style.transformOrigin = '0px 0px 0px';
                this._gameFrame.style.margin = `0 0 0 ${winWidth}px`;
                this._gameFrame.style.width = `${winHeight}px`;
                this._gameFrame.style.height = `${winWidth}px`;
            } else {
                // console.log(
                //     `screen adapter resizeFrame - isFrameRotated: [${this.isFrameRotated}] - setting rotate(0deg)`
                // );
                this._gameFrame.style['-webkit-transform'] = 'rotate(0deg)';
                this._gameFrame.style.transform = 'rotate(0deg)';
                // TODO
                // this._gameFrame.style['-webkit-transform-origin'] = '0px 0px 0px';
                // this._gameFrame.style.transformOrigin = '0px 0px 0px';
                this._gameFrame.style.margin = '0px auto';
                this._gameFrame.style.width = `${winWidth}px`;
                this._gameFrame.style.height = `${winHeight}px`;
            }
        }

        this._updateContainer();
    }

    private _getFullscreenTarget () {
        const windowType = this._windowType;
        if (windowType === WindowType.Fullscreen) {
            return document[this._fn.fullscreenElement] as HTMLElement;
        }
        if (windowType === WindowType.SubFrame) {
            return this._gameFrame;
        }
        // On web mobile, the transform of game frame doesn't work when it's on fullscreen.
        // So we need to make the body fullscreen.
        return document.body;
    }
    private _doRequestFullScreen (): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this._supportFullScreen) {
                reject(new Error('fullscreen is not supported'));
                return;
            }
            const fullscreenTarget = this._getFullscreenTarget();
            if (!fullscreenTarget) {
                reject(new Error('Cannot access fullscreen target'));
                return;
            }
            this._onFullscreenChange = undefined;
            this._onFullscreenError = undefined;
            const requestPromise = fullscreenTarget[
                this._fn.requestFullscreen
            ]() as Promise<void> | undefined;
            if (window.Promise && requestPromise instanceof Promise) {
                requestPromise.then(resolve).catch(reject);
            } else {
                this._onFullscreenChange = resolve;
                this._onFullscreenError = reject;
            }
        });
    }
    private _updateFrameState () {
        const orientation = this.orientation;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const isBrowserLandscape = width > height;
        const isSquare = width === height;
        this.isFrameRotated =            !isSquare
            && systemInfo.isMobile
            && ((isBrowserLandscape && orientation === Orientation.PORTRAIT)
                || (!isBrowserLandscape && orientation === Orientation.LANDSCAPE));

        // console.log(
        //     `screen adapter update frame state: orientation [${
        //         orientation === Orientation.PORTRAIT ? "portrait" : "landscape"
        //     }] width: [${width}] height: [${height}] isBrowserLandscape: [${isBrowserLandscape}] is frame rotated: [${
        //         this.isFrameRotated
        //     }]`
        // );
    }
    private _updateContainer () {
        if (!this._gameContainer) {
            warnID(9201);
            return;
        }
        if (this.isProportionalToFrame) {
            if (!this._gameFrame) {
                warnID(9201);
                return;
            }
            // TODO: access designedResolution from Launcher module.
            const designedResolution =                legacyCC.view.getDesignResolutionSize() as Size;
            const frame = this._gameFrame;
            const frameW = frame.clientWidth;
            const frameH = frame.clientHeight;
            const designW = designedResolution.width;
            const designH = designedResolution.height;
            const scaleX = frameW / designW;
            const scaleY = frameH / designH;
            const containerStyle = this._gameContainer.style;
            let containerW: number;
            let containerH: number;

            if (scaleX < scaleY) {
                containerW = frameW;
                containerH = designH * scaleX;
            } else {
                containerW = designW * scaleY;
                containerH = frameH;
            }
            // Set window size on game container
            containerStyle.width = `${containerW}px`;
            containerStyle.height = `${containerH}px`;
        } else {
            const containerStyle = this._gameContainer.style;
            // game container exact fit game frame.
            containerStyle.width = '100%';
            containerStyle.height = '100%';
        }

        // Cache Test
        if (
            this._gameFrame
            && (this._cachedFrameStyle.width !== this._gameFrame.style.width
                || this._cachedFrameStyle.height
                    !== this._gameFrame.style.height
                || this._cachedContainerStyle.width
                    !== this._gameContainer.style.width
                || this._cachedContainerStyle.height
                    !== this._gameContainer.style.height)
        ) {
            this.emit('window-resize');

            // Update Cache
            this._cachedFrameStyle.width = this._gameFrame.style.width;
            this._cachedFrameStyle.height = this._gameFrame.style.height;
            this._cachedContainerStyle.width = this._gameContainer.style.width;
            this._cachedContainerStyle.height =                this._gameContainer.style.height;
        }
    }
}

export const screenAdapter = new ScreenAdapter();
