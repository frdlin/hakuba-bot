// 人工客服服務時間：日本時間（JST，UTC+9）09:00–18:00

const SERVICE_START_HOUR = 9;
const SERVICE_END_HOUR = 18;

export function isWithinServiceHours(date = new Date()) {
  const jstHour = (date.getUTCHours() + 9) % 24;
  return jstHour >= SERVICE_START_HOUR && jstHour < SERVICE_END_HOUR;
}

export const OFF_HOURS_MESSAGE = {
  zh: "目前非人工客服服務時間（日本時間 09:00–18:00），已為您記錄這則訊息，管家會在服務時間內盡快回覆您。這段時間我可以先協助您查詢資訊 😊",
  en: "Our staff support hours are 9:00 AM–6:00 PM Japan time, and we're currently outside those hours. I've noted your message and our team will follow up once they're back online. In the meantime, feel free to ask me anything! 😊",
  ja: "現在はスタッフ対応時間外です（日本時間 9:00〜18:00）。メッセージは記録しておりますので、営業時間内に改めてご連絡いたします。その間もAIがご案内いたしますので、お気軽にお尋ねください 😊",
};
