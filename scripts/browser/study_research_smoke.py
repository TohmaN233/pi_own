"""Full local UI smoke against an isolated fixture, not a pedagogical evaluation.
Requires a production server and Playwright Chromium. No generated model responses.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(os.environ['PI_STUDY_BROWSER_ROOT'])
fixture = json.loads((root / 'fixture.json').read_text())
out = root / 'browser-evidence'
out.mkdir(exist_ok=True)
base = os.environ.get('PI_SMOKE_URL', 'http://127.0.0.1:30141')
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1050})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/study-research?sessionId=' + fixture['sessionId'])
    page.get_by_role('heading', name='论文精读：连续不等于有界').wait_for()
    page.get_by_role('button', name='生成／修订阅读地图').wait_for()
    page.wait_for_function("()=>!Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='生成／修订阅读地图').disabled")
    page.locator('select').filter(has=page.locator('option[value="counterexample"]')).select_option('counterexample')
    page.get_by_role('heading', name='检查反例与缺失假设').wait_for()
    assert page.locator('.katex').count() > 0
    page.screenshot(path=str(out / 'study-reading.png'), full_page=True)
    page.get_by_role('button', name='笔记', exact=True).click()
    page.get_by_label('我的数学笔记').fill('我用 $f(x)=x$ 检查该结论。有限样本不是全称证明。')
    page.get_by_role('button', name='保存我的笔记', exact=True).click()
    page.get_by_text('我的笔记', exact=True).wait_for()
    page.reload()
    page.get_by_role('button', name='笔记', exact=True).click()
    page.get_by_text('我的笔记', exact=True).wait_for()
    assert page.get_by_text('Agent 笔记', exact=True).count() >= 1
    page.get_by_role('button', name='代码实验台', exact=True).click()
    page.get_by_label('实验代码').fill('print(sum(range(1, 11)))')
    page.get_by_role('button', name='保存新的计划修订', exact=True).click()
    page.get_by_text('当前保存 r1', exact=False).wait_for()
    assert page.get_by_role('button', name='运行已批准版本', exact=True).is_disabled()
    confirmation=page.get_by_role('checkbox', name='我已检查下面这个版本的计划和代码，并同意在本机运行。')
    confirmation.check()
    page.get_by_role('button', name='批准此版本', exact=True).click()
    page.wait_for_function("()=>!document.querySelector('section input[type=checkbox]')?.checked")
    confirmation.check()
    run=page.get_by_role('button', name='运行已批准版本', exact=True)
    run.click()
    page.get_by_role('heading', name='succeeded', exact=False).wait_for(timeout=30000)
    assert '55' in page.get_by_label('运行输出').first.inner_text()
    assert run.is_disabled(), 'Consumed approvals may not replay'
    page.screenshot(path=str(out / 'study-code.png'), full_page=True)
    page.get_by_role('button', name='2D / 3D 可视化', exact=True).click()
    page.get_by_role('button', name='生成／更新可视化', exact=True).click()
    frame=page.frame_locator('iframe[title="交互式数学可视化"]')
    frame.locator('.scatterlayer path.js-line').first.wait_for()
    page.get_by_text('浏览器已完成绘制', exact=False).wait_for()
    page.screenshot(path=str(out / 'study-2d.png'), full_page=True)
    page.get_by_role('button', name='surface3d', exact=True).click()
    page.get_by_role('button', name='生成／更新可视化', exact=True).click()
    frame.locator('.gl-container canvas').first.wait_for(timeout=30000)
    page.get_by_text('浏览器已完成绘制', exact=False).wait_for()
    view=next(f for f in page.frames if 'math-visualization.html' in f.url)
    before=view.evaluate('JSON.stringify(document.getElementById("plot")._fullLayout.scene.camera)')
    iframe=page.locator('iframe[title="交互式数学可视化"]')
    iframe.scroll_into_view_if_needed()
    box=iframe.bounding_box()
    page.mouse.move(box['x']+250,box['y']+200);page.mouse.down()
    page.mouse.move(box['x']+430,box['y']+280,steps=15);page.mouse.up()
    page.wait_for_timeout(500)
    after=view.evaluate('JSON.stringify(document.getElementById("plot")._fullLayout.scene.camera)')
    assert before != after, '3D must respond to user rotation'
    page.screenshot(path=str(out / 'study-3d.png'), full_page=True)
    # Same actual plugin in the pre-existing Course Builder, not a second renderer.
    page.goto(base + '/course-builder?sessionId=' + fixture['courseSid'])
    panel=page.get_by_role('region', name='共享数学可视化')
    panel.wait_for(timeout=30000)
    page.wait_for_function("async sid=>(await fetch('/api/math-visualization?sessionId='+encodeURIComponent(sid))).ok", arg=fixture['courseSid'], timeout=30000)
    panel.get_by_role('button', name='生成／更新可视化', exact=True).click()
    panel.get_by_text('浏览器已完成绘制', exact=False).wait_for(timeout=30000)
    assert panel.get_by_role('combobox', name='已保存可视化').locator('option').count() == 2, 'Study artifacts cannot leak into Course scope'
    page.screenshot(path=str(out / 'course-shared-math.png'), full_page=True)
    assert not errors, errors
    (out / 'result.json').write_text(json.dumps({'result': 'pass', 'realHttpApi': True, 'realPython': True, 'realWebGL': True, 'modelCalls': 0, 'pageErrors': errors}, indent=2))
    browser.close()
print('Study reading/math notes, explicit code approval/run, 2D/3D and shared Course plugin passed.')
