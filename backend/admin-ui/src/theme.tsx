import {App as AntApp, ConfigProvider, type ThemeConfig} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type {ReactNode} from 'react';

export const adminTheme: ThemeConfig = {
  token: {colorPrimary: '#2563eb', colorText: '#182230', colorTextSecondary: '#667085',
    colorBorder: '#dfe3e8', colorBgLayout: '#f7f8fa', borderRadius: 8, fontSize: 14,
    controlHeight: 36, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
    boxShadow: '0 8px 32px rgba(16, 24, 40, .10)'},
  components: {Button: {primaryShadow: 'none'}, Tabs: {horizontalItemGutter: 24},
    Drawer: {paddingLG: 24}, Table: {headerBg: '#f8fafc'}},
};
export function AdminTheme({children}: {children: ReactNode}) {
  return <ConfigProvider locale={zhCN} theme={adminTheme} button={{autoInsertSpace: false}}><AntApp>{children}</AntApp></ConfigProvider>;
}
