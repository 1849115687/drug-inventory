#!/usr/bin/env python3
"""为 Capacitor MainActivity 注入崩溃捕捉器（诊断 APK 扫码闪退用，定位根因后移除）。

崩溃时把堆栈写入 getExternalFilesDir/crash.txt；下次启动弹窗显示堆栈文本。
幂等：已含 crash.txt 则跳过。
"""
import os

MAIN = 'android/app/src/main/java/com/xiaodian/druginventory/MainActivity.java'

NEW = '''package com.xiaodian.druginventory;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable e) {
                try {
                    java.io.File f = new java.io.File(getExternalFilesDir(null), "crash.txt");
                    java.io.PrintWriter w = new java.io.PrintWriter(f);
                    e.printStackTrace(w);
                    w.close();
                } catch (Exception ignore) {}
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(1);
            }
        });
        super.onCreate(savedInstanceState);
        try {
            java.io.File f = new java.io.File(getExternalFilesDir(null), "crash.txt");
            if (f.exists()) {
                StringBuilder sb = new StringBuilder();
                java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f));
                String line;
                while ((line = r.readLine()) != null) sb.append(line).append("\\n");
                r.close();
                f.delete();
                new android.app.AlertDialog.Builder(this)
                    .setTitle("上次崩溃的日志（请截图发我）")
                    .setMessage(sb.toString())
                    .setPositiveButton("知道了", null)
                    .show();
            }
        } catch (Exception ignore) {}
    }
}
'''


def main():
    if not os.path.exists(MAIN):
        print('MainActivity not found at ' + MAIN)
        raise SystemExit(1)
    src = open(MAIN, encoding='utf-8').read()
    if 'crash.txt' in src:
        print('MainActivity already patched, skip')
        return
    open(MAIN, 'w', encoding='utf-8').write(NEW)
    print('MainActivity patched with crash catcher')


if __name__ == '__main__':
    main()
