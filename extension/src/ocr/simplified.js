// Simplified characters the OCR model prints for traditional ones. PP-OCR's Chinese recogniser is trained mostly on
// simplified text, so on the traditional D2R tooltip it sometimes answers 盗贼皇冠 for 盜賊皇冠 (measured on
// IMG_0401.jpg) or 殺手护盔 for 殺手護盔. Every table name is traditional, so the matcher turns the simplified form
// back before it compares.
//
// The pairs are mechanical: for every character of the shipped Chinese names (extension/src/traderie/data/items.json)
// that has a simplified form, that form maps back to it. A simplified form that is itself a character of some table
// name (里, 制, 布, ...) is left out, because it is valid traditional text too; where two table characters share one
// simplified form the more frequent one wins (锤 -> 鎚, 发 -> 發). Regenerate them when the table's characters change.
const SIMPLIFIED =
  "万东丝严丧丽义乌乔书乱争云亚亵仆从仪价优会伟传伤伪体侠侧儿兰关兹兽内册军农冲决净" +
  "准凤凯击凿则刚刽剂剑剥剧动劳勋区华卢卫压双发变台叶号叹后呕响哒唤啸喷团国图圆圣场" +
  "块坚坠垒墙声壳处备复头夺奥学宁宝实审宾导将尔尸尽属岁岛币师帜带庄库庞开异弑张弯弹" +
  "强忆忏怀恒恶恸恼悬惊惧愈愤愿战执扩抚抛护拢拥挣挽掷摆斩断无旧晕术机杀杂权条杰极枪" +
  "标树桠梦检欧欲残毁毕气泪涡渎温溃潜灭灵灿炉炼炽烁烂烟烦烧热爱狞狮狰狱猎猫玛环琐电" +
  "画疗监盖盗盘瞒礼祸窃笼紧红纤约级纪纱纲纳纹线组细织结绕绝统绳维绷绸绿缀缓缘缚缝缩" +
  "网罗罚职肤胆胜胫脉脏脑脓脚脸腾节苍苏范荆荣药莱萝萨蓝蔷虚虫蚀蛮袭装观视触计训记证" +
  "识诗话诞诡该语诲说诵诸诺谐谜谢谨贝财责败贪费贼赌赎赞躯软轰轴轻辉边达运进连遗采释" +
  "针钉钟钢钥钩钳钴钺钻铁铅铐铠铲银链锁锈锋锐错锤锥锯锲锹锻镇镐镖镜镯镰镶长门闪问间" +
  "阀阔阳阴随隐难雾静韧韩韵顶项顿颅领颊颚风飘飞饥饰马驰骄骑髅鱼鲁鲛鲜鲨鳞鸟鸢鸣鸥鸦" +
  "鹤鹫鹰麦黄齿龙";
const TRADITIONAL =
  "萬東絲嚴喪麗義烏喬書亂爭雲亞褻僕從儀價優會偉傳傷偽體俠側兒蘭關茲獸內冊軍農衝決淨" +
  "準鳳凱擊鑿則剛劊劑劍剝劇動勞勳區華盧衛壓雙發變颱葉號嘆後嘔響噠喚嘯噴團國圖圓聖場" +
  "塊堅墜壘牆聲殼處備復頭奪奧學寧寶實審賓導將爾屍盡屬歲島幣師幟帶莊庫龐開異弒張彎彈" +
  "強憶懺懷恆惡慟惱懸驚懼癒憤願戰執擴撫拋護攏擁掙輓擲擺斬斷無舊暈術機殺雜權條傑極槍" +
  "標樹椏夢檢歐慾殘毀畢氣淚渦瀆溫潰潛滅靈燦爐鍊熾爍爛煙煩燒熱愛獰獅猙獄獵貓瑪環瑣電" +
  "畫療監蓋盜盤瞞禮禍竊籠緊紅纖約級紀紗綱納紋線組細織結繞絕統繩維繃綢綠綴緩緣縛縫縮" +
  "網羅罰職膚膽勝脛脈臟腦膿腳臉騰節蒼蘇範荊榮藥萊蘿薩藍薔虛蟲蝕蠻襲裝觀視觸計訓記證" +
  "識詩話誕詭該語誨說誦諸諾諧謎謝謹貝財責敗貪費賊賭贖讚軀軟轟軸輕輝邊達運進連遺採釋" +
  "針釘鐘鋼鑰鉤鉗鈷鉞鑽鐵鉛銬鎧鏟銀鏈鎖鏽鋒銳錯鎚錐鋸鍥鍬鍛鎮鎬鏢鏡鐲鐮鑲長門閃問間" +
  "閥闊陽陰隨隱難霧靜韌韓韻頂項頓顱領頰顎風飄飛饑飾馬馳驕騎髏魚魯鮫鮮鯊鱗鳥鳶鳴鷗鴉" +
  "鶴鷲鷹麥黃齒龍";

const BACK = new Map([...SIMPLIFIED].map((character, at) => [character, [...TRADITIONAL][at]]));

/** `text` with every simplified character in the table above turned back into its traditional one. */
export function toTraditional(text) {
  let out = "";
  for (const character of text) out += BACK.get(character) ?? character;
  return out;
}
