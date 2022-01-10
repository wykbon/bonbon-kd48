import * as querystring from 'node:querystring';
import { CronJob } from 'cron';
import { message } from 'antd';
import * as dayjs from 'dayjs';
import { renderString } from 'nunjucks';
import Basic, { type MessageListener } from './Basic';
import {
  requestAuth,
  requestAuthV2,
  requestVerify,
  requestVerifyV2,
  requestRelease,
  requestSendGroupMessage,
  requestManagers,
  requestAbout
} from './services/services';
import { requestJoinRank } from './services/taoba';
import { ChatroomMember } from './NimChatroomSocket';
import { plain, atAll, miraiTemplate, getGroupNumbers, getSocketHost, LogCommandData } from './utils/miraiUtils';
import { getRoomMessage, getLogMessage, log, type RoomMessageArgs } from './utils/pocket48Utils';
import type { OptionsItemValue, MemberInfo, EditItem } from '../types';
import type {
  Plain,
  AuthResponse,
  MessageResponse,
  AboutResponse,
  MessageChain,
  MessageSocketEventData,
  MessageSocketEventDataV2,
  EventSocketEventData,
  EventSocketEventDataV2,
  NIMMessage,
  CustomMessageAll,
  TaobaRankItem,
  TaobaJoinRank
} from './qq.types';

type CloseListener = (event: CloseEvent) => void | Promise<void>;

class QQ extends Basic {
  public protocol: string = 'mirai';
  public socketStatus: -1 | 0; // -1 关闭，0 正常
  public eventSocket?: WebSocket;
  public messageSocket?: WebSocket;
  public reconnectTimer: number | null; // 断线重连
  public session: string;
  #miraiApiHttpV2: boolean = false;

  constructor(id: string, config: OptionsItemValue, membersList?: Array<MemberInfo>) {
    super();

    this.id = id;         // 当前登陆的唯一id
    this.config = config; // 配置
    this.membersList = membersList;
    this.groupNumbers = getGroupNumbers(this.config.groupNumber);
    this.socketStatus = 0;
    this.socketHost = getSocketHost(config.socketHost);
  }

  // message事件监听
  handleMessageSocketMessage: MessageListener = async (event: MessageEvent): Promise<void> => {
    const { qqNumber, customCmd }: OptionsItemValue = this.config;
    const groupNumbers: Array<number> = this.groupNumbers;
    const eventData: MessageSocketEventData | MessageSocketEventDataV2 = JSON.parse(event.data);
    const data: MessageSocketEventData = 'syncId' in eventData ? eventData.data : eventData;

    // 群信息
    if (data.type === 'GroupMessage' && data.sender.id !== qqNumber && groupNumbers.includes(data.sender.group.id)) {
      if (data.messageChain?.[1].type === 'Plain') {
        const command: string = data.messageChain[1].text; // 当前命令
        const groupId: number = data.sender.group.id;      // 收到消息的群

        // 日志信息输出
        if (command === 'log') {
          this.logCommandCallback(groupId);

          return;
        }

        if (command === 'pocketroom') {
          this.membersInRoom(groupId);

          return;
        }

        // 集资命令处理
        if (['taoba', '桃叭', 'jizi', 'jz', '集资'].includes(command)) {
          this.taobaoCommandCallback(groupId);

          return;
        }

        // 排行榜命令处理
        if (['排行榜', 'phb'].includes(command)) {
          this.taobaoCommandRankCallback(groupId);

          return;
        }

        // 自定义信息处理
        if (customCmd?.length) {
          const index: number = customCmd.findIndex((o: EditItem): boolean => o.cmd === command);

          if (index >= 0) {
            const value: Array<MessageChain> = miraiTemplate(customCmd[index].value);

            await this.sendMessage(value, groupId);
          }
        }
      }
    }
  };

  // socket事件监听
  handleEventSocketMessage: MessageListener = async (event: MessageEvent): Promise<void> => {
    const { qqNumber, groupWelcome, groupWelcomeSend }: OptionsItemValue = this.config;
    const groupNumbers: Array<number> = this.groupNumbers;
    const eventData: EventSocketEventData | EventSocketEventDataV2 = JSON.parse(event.data);
    const data: EventSocketEventData = 'syncId' in eventData ? eventData.data : eventData;

    // 欢迎进群
    if (data.type === 'MemberJoinEvent' && data.member.id !== qqNumber && groupNumbers.includes(data.member.group.id)) {
      if (groupWelcome && groupWelcomeSend) {
        const value: Array<MessageChain> = miraiTemplate(groupWelcomeSend, {
          qqNumber: data.member.id
        });

        await this.sendMessage(value, data.member.group.id);
      }
    }
  };

  // socket关闭
  handleSocketClose: CloseListener = (event: CloseEvent): void => {
    if (this.socketStatus === -1 || this.#miraiApiHttpV2) return;

    this.destroyWebsocket(); // 清除旧的socket
    this.reconnectTimer = window.setTimeout(this.reconnectLogin, 3_000);
  };

  // 断线重连
  reconnectLogin: Function = async (): Promise<void> => {
    try {
      const { socketHost }: this = this;
      const { socketPort, qqNumber }: OptionsItemValue = this.config;
      const res: MessageResponse | Array<any> = await requestManagers(socketHost, socketPort, qqNumber);

      if (Array.isArray(res)) {
        const result: boolean = await this.getSession();

        if (result) {
          this.initWebSocket();
        } else {
          this.reconnectTimer = window.setTimeout(this.reconnectLogin, 3_000);
        }
      } else {
        this.reconnectTimer = window.setTimeout(this.reconnectLogin, 3_000);
      }
    } catch (err) {
      console.error(err);
      this.reconnectTimer = window.setTimeout(this.reconnectLogin, 3_000);
    }
  };

  // websocket初始化
  initWebSocket(): void {
    const { socketHost }: this = this;
    const { socketPort, authKey, qqNumber }: OptionsItemValue = this.config;
    const query: string = querystring.stringify(
      this.#miraiApiHttpV2 ? {
        verifyKey: authKey,
        sessionKey: this.session,
        qq: qqNumber
      } : {
        sessionKey: this.session
      }
    );

    this.messageSocket = new WebSocket(`ws://${ socketHost }:${ socketPort }/message?${ query }`);
    this.eventSocket = new WebSocket(`ws://${ socketHost }:${ socketPort }/event?${ query }`);
    this.messageSocket.addEventListener('message', this.handleMessageSocketMessage, false);
    this.eventSocket.addEventListener('message', this.handleEventSocketMessage, false);
    this.messageSocket.addEventListener('close', this.handleSocketClose, false);
    this.eventSocket.addEventListener('close', this.handleSocketClose, false);
  }

  // websocket销毁
  destroyWebsocket(): void {
    if (this.eventSocket) {
      this.eventSocket.removeEventListener('message', this.handleEventSocketMessage);
      this.eventSocket.removeEventListener('close', this.handleSocketClose, false);
      this.eventSocket.close();
      this.eventSocket = undefined;
    }

    if (this.messageSocket) {
      this.messageSocket.removeEventListener('message', this.handleMessageSocketMessage);
      this.messageSocket.removeEventListener('close', this.handleSocketClose, false);
      this.messageSocket.close();
      this.messageSocket = undefined;
    }
  }

  // 获取session
  async getSession(): Promise<boolean> {
    const { socketHost }: this = this;
    const { qqNumber, socketPort, authKey }: OptionsItemValue = this.config;

    // 获取插件版本号
    const about: AboutResponse = await requestAbout(socketHost, socketPort);

    this.#miraiApiHttpV2 = /^2/.test(about.data.version);

    const authRes: AuthResponse = await (this.#miraiApiHttpV2 ? requestAuthV2 : requestAuth)(
      socketHost, socketPort, authKey);

    if (authRes.code !== 0) {
      message.error('登陆失败：获取session失败。');

      return false;
    }

    this.session = authRes.session;

    const verifyRes: MessageResponse = await (this.#miraiApiHttpV2 ? requestVerifyV2 : requestVerify)(
      qqNumber, socketHost, socketPort, this.session);

    if (verifyRes.code === 0) {
      return true;
    } else {
      message.error('登陆失败：session认证失败。');

      return false;
    }
  }

  /**
   * 发送信息
   * @param { Array<MessageChain> } value: 要发送的信息
   * @param { number } groupId: 单个群的群号
   */
  async sendMessage(value: Array<MessageChain>, groupId?: number): Promise<void> {
    try {
      const { socketHost }: this = this;
      const { socketPort }: OptionsItemValue = this.config;
      const groupNumbers: Array<number> = this.groupNumbers;

      if (typeof groupId === 'number') {
        // 只发送到一个群
        await requestSendGroupMessage(groupId, socketHost, socketPort, this.session, value);
      } else {
        // 发送到多个群
        await Promise.all(
          groupNumbers.map((item: number, index: number): Promise<MessageResponse> => {
            return requestSendGroupMessage(item, socketHost, socketPort, this.session, value);
          })
        );
      }
    } catch (err) {
      console.error(err);
    }
  }

  // 日志回调函数
  async logCommandCallback(groupId: number): Promise<void> {
    const { qqNumber }: OptionsItemValue = this.config;
    const msg: string = LogCommandData('mirai', qqNumber, this.startTime);

    await this.sendMessage([plain(msg)], groupId);
  }

  /* ==================== 业务相关 ==================== */

  // 处理单个消息
  async roomSocketMessage(event: Array<NIMMessage>): Promise<void> {
    const {
      pocket48LiveAtAll,
      pocket48ShieldMsgType,
      pocket48MemberInfo,
      pocket48LogSave,
      pocket48LogDir
    }: OptionsItemValue = this.config;
    const data: NIMMessage = event[0];                            // 房间信息数组
    const customInfo: CustomMessageAll = JSON.parse(data.custom); // 房间自定义信息
    const { sessionRole }: CustomMessageAll = customInfo;         // 信息类型和sessionRole

    if (Number(sessionRole) === 0 && customInfo.messageType !== 'PRESENT_TEXT') return; // 过滤发言

    if (pocket48ShieldMsgType && pocket48ShieldMsgType.includes(customInfo.messageType)) {
      return; // 屏蔽信息类型
    }

    // 发送的数据
    const roomMessageArgs: RoomMessageArgs = {
      customInfo,
      data,
      pocket48LiveAtAll,
      event,
      pocket48ShieldMsgType,
      memberInfo: this.memberInfo,
      pocket48MemberInfo
    };
    const sendGroup: Array<MessageChain> = getRoomMessage(roomMessageArgs);

    if (sendGroup.length > 0) {
      await this.sendMessage(sendGroup);
    }

    // 日志
    if (pocket48LogSave && pocket48LogDir && !/^\s*$/.test(pocket48LogDir)) {
      const logData: string | undefined = getLogMessage({
        customInfo,
        data,
        event,
        memberInfo: this.memberInfo
      });

      if (logData) {
        await log(pocket48LogDir, logData);
      }
    }
  }

  // 输出当前房间的游客信息
  membersInRoom(groupId: number): void {
    const { pocket48RoomEntryListener }: OptionsItemValue = this.config;

    if (pocket48RoomEntryListener && this.membersList?.length && this.memberInfo) {
      const members: Array<MemberInfo> = this.membersCache ?? [];
      const nowMembers: string[] = []; // 本次房间内小偶像的数组
      const name: string = this.memberInfo?.ownerName!;

      for (const member of members) {
        nowMembers.push(member.ownerName);
      }

      let text: string = `${ dayjs().locale('en').format('DD/MMM HH:mm:ss') }在 ${ name } 的房间：\n`;

      if (nowMembers?.length) {
        text += `${ nowMembers.join('\n') }`;
      } else {
        text += '暂无成员';
      }

      this.sendMessage([plain(text)], groupId);
    }
  }

  // 获取房间信息
  handleRoomEntryTimer: Function = async (): Promise<void> => {
    try {
      const members: Array<ChatroomMember> = await this.nimChatroom!.getChatroomMembers();
      const entryLog: string[] = [], // 进入房间的log日志的数组
        outputLog: string[] = [];    // 退出房间的log日志的数组
      const nowMembers: Array<MemberInfo> = []; // 本次房间内小偶像的数组
      const name: string = this.memberInfo?.ownerName!;
      const { pocket48LogSave, pocket48LogDir }: OptionsItemValue = this.config;

      // 获取进入房间的信息
      for (const member of members) {
        // 判断是否是小偶像
        const idx: number = (this.membersList ?? []).findIndex((o: MemberInfo): boolean => o.account === member.account);

        if (idx < 0) {
          continue;
        }

        const xoxMember: MemberInfo = this.membersList![idx];

        nowMembers.push(xoxMember); // 当前房间的小偶像

        // 没有缓存时不做判断
        if (!this.membersCache) {
          console.log(`${ xoxMember.ownerName } 在 ${ name } 的房间内`);
          continue;
        }

        // 判断是否进入过房间（存在于缓存中）
        const idx1: number = this.membersCache.findIndex((o: MemberInfo): boolean => o.account === xoxMember.account);

        if (idx1 < 0) {
          entryLog.push(`${ xoxMember.ownerName } 进入了 ${ name } 的房间✔️`);
        }
      }

      // 离开房间的信息（缓存内的信息不在新信息中）
      if (this.membersCache) {
        for (const member of this.membersCache) {
          const idx: number = nowMembers.findIndex((o: MemberInfo): boolean => o.account === member.account);

          if (idx < 0) {
            outputLog.push(`${ member.ownerName } 离开了 ${ name } 的房间❌`);
          }
        }
      }

      this.membersCache = nowMembers; // 保存当前房间的xox信息

      const allLogs: Array<string> = entryLog.concat(outputLog);

      if (allLogs?.length) {
        const logText: string = `${ dayjs().locale('en').format('DD/MMM HH:mm:ss') }\n${ allLogs.join('\n') }`;

        await this.sendMessage([plain(logText)]);

        // 日志
        if (pocket48LogSave && pocket48LogDir && !/^\s*$/.test(pocket48LogDir)) {
          await log(pocket48LogDir, logText);
        }
      }
    } catch (err) {
      console.error(err);
    }

    this.roomEntryListener = setTimeout(this.handleRoomEntryTimer, 20_000);
  };

  // 成员在线离线监听
  handleOwnerOnlineTimer: Function = async (): Promise<void> => {
    try {
      const members: Array<ChatroomMember> = await this.nimChatroom!.getChatroomMembers(false);
      const online: boolean = members[0]?.online;
      const name: string = this.memberInfo?.ownerName!;

      if (this.ownerOnlineCache === false && online === true) {
        // 上线
        await this.sendMessage([plain(`${ name } 进入房间⚡。
${ dayjs().locale('en').format('DD/MMM HH:mm:ss') }`)]);
      }

      if (this.ownerOnlineCache === true && online === false) {
        await this.sendMessage([plain(`${ name } 离开房间🚀。
${ dayjs().locale('en').format('DD/MMM HH:mm:ss') }`)]);
      }

      this.ownerOnlineCache = online;
    } catch (err) {
      console.error(err);
    }

    this.ownerOnlineTimer = setTimeout(this.handleOwnerOnlineTimer, 20_000);
  };

  // 微博监听
  handleWeiboWorkerMessage: MessageListener = async (event: MessageEvent): Promise<void> => {
    await this.sendMessage(event.data.sendGroup);
  };

  // bilibili message监听事件
  handleBilibiliWorkerMessage: MessageListener = async (event: MessageEvent): Promise<void> => {
    const { bilibiliAtAll }: OptionsItemValue = this.config;
    const text: string = `bilibili：${ this.bilibiliUsername }在B站开启了直播。`;
    const sendMessage: Array<MessageChain> = [plain(text)];

    if (bilibiliAtAll) {
      sendMessage.unshift(atAll());
    }

    await this.sendMessage(sendMessage);
  };

  // 桃叭命令的回调函数
  async taobaoCommandCallback(groupId: number): Promise<void> {
    const { taobaListen, taobaId, taobaCommandTemplate }: OptionsItemValue = this.config;

    if (taobaListen && taobaId) {
      const msg: string = renderString(taobaCommandTemplate, {
        title: this.taobaInfo.title,
        taobaid: taobaId
      });

      await this.sendMessage([plain(msg)], groupId);
    }
  }

  // 桃叭排行榜的回调函数
  async taobaoCommandRankCallback(groupId: number): Promise<void> {
    const { taobaListen, taobaId }: OptionsItemValue = this.config;

    if (taobaListen && taobaId) {
      const res: TaobaJoinRank = await requestJoinRank(taobaId);
      const list: Array<Plain> = res.list.map((item: TaobaRankItem, index: number): Plain => {
        return plain(`\n${ index + 1 }、${ item.nick }：${ item.money }`);
      });
      const msg: string = `${ this.taobaInfo.title } 排行榜
集资参与人数：${ res.juser }人`;

      await this.sendMessage([plain(msg)].concat(list), groupId);
    }
  }

  // 定时任务初始化
  initCronJob(): void {
    const { cronJob, cronTime, cronSendData }: OptionsItemValue = this.config;

    if (cronJob && cronTime && cronSendData) {
      this.cronJob = new CronJob(cronTime, (): void => {
        this.sendMessage(miraiTemplate(cronSendData));
      });
      this.cronJob.start();
    }
  }

  // 项目初始化
  async init(): Promise<boolean> {
    try {
      const result: boolean = await this.getSession();

      if (!result) throw new Error('登陆失败！');

      this.initWebSocket();
      await this.initPocket48();
      await this.initWeiboWorker();
      this.initWeiboSuperTopicWorker();
      await this.initBilibiliWorker();
      await this.initTaoba();
      this.initCronJob();
      this.startTime = dayjs().locale('en').format('DD/MMM HH:mm:ss');

      return true;
    } catch (err) {
      console.error(err);

      return false;
    }
  }

  // 项目销毁
  async destroy(): Promise<boolean> {
    const { socketHost }: this = this;
    const { qqNumber, socketPort }: OptionsItemValue = this.config;

    try {
      await requestRelease(qqNumber, socketHost, socketPort, this.session); // 清除session
    } catch (err) {
      console.error(err);
    }

    try {
      // 销毁socket监听
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }

      this.socketStatus = -1;
      this.destroyWebsocket();

      // 销毁口袋监听
      if (this.nimChatroomSocketId) {
        this.disconnectPocket48();
      }

      // 销毁微博监听
      if (this.weiboWorker) {
        this.weiboWorker.terminate();
        this.weiboWorker = undefined;
      }

      // 销毁微博超级话题监听
      if (this.weiboSuperTopicWorker) {
        this.weiboSuperTopicWorker.terminate();
        this.weiboSuperTopicWorker = undefined;
      }

      // 销毁bilibili监听
      if (this.bilibiliWorker) {
        this.bilibiliWorker.terminate();
        this.bilibiliWorker = undefined;
      }

      // 销毁定时任务
      if (this.cronJob) {
        this.cronJob.stop();
        this.cronJob = undefined;
      }

      return true;
    } catch (err) {
      console.error(err);

      return false;
    }
  }
}

export default QQ;
