<table>
    <thead>
        <tr>
            <th>Library</th>
            <th>Three.js</th>
            <th>Babylon.js</th>
            <th>CesiumJS</th>
            <th>iTwin.js</th>
        </tr>
    </thead>
    <tbody>
        <!-- DESCRIPTION -->
        <tr>
            <td>Description</td>
            <td>More like an API for WebGL. Use Three.js to handle the 3D rendering.</td>
            <td>Real time 3D engine (oriented for game-development).</td>
            <td>Globe and map engine for 3D geospatial visualization.<br/>Part of Bentley Systems since mid-2024.</td>
            <td>Open-source library for building web apps on the Bentley iTwin Platform.</td>
        </tr>
        <!-- UI FEATURES -->
        <tr>
            <td><strong>Support for user interface features</strong></td>
            <td>❌</td>
            <td>✅</td>
            <td>❌</td>
            <td>✅</td>
        </tr>
        <tr>
            <td>Table</td>
            <td rowspan="6">Must use an external library or HTML + JS.<br/>Possible to display <a href="https://threejs.org/docs/#api/en/loaders/ImageLoader">image</a> / <a href="https://threejs.org/docs/#examples/en/geometries/TextGeometry">text</a> / <a href="https://threejs.org/docs/#api/en/textures/VideoTexture">video</a> as texture but can’t interact with them.</td>
            <td rowspan="6">Can be done using <a href="https://doc.babylonjs.com/features/featuresDeepDive/gui/">Babylon.GUI</a> (⚠️ depending on the <a href="https://doc.babylonjs.com/features/featuresDeepDive/gui/#comparison-of-gui-options">type of GUI</a> used, it can either be part of the 3D scene or not).</td>
            <td rowspan="4">Must use an external library or HTML + JS. Possible to display images and videos as textures and texts as labels.</td>
            <td rowspan="6">Can be achieved using <a href="https://www.itwinjs.org/ui/appui/">iTwin.js UI</a> (based on React) and <a href="https://www.itwinjs.org/presentation/">iTwin.js Presentation</a> libraries.</td>
        </tr>
        <tr>
            <td>Chart</td>
        </tr>
        <tr>
            <td>Image</td>
        </tr>
        <tr>
            <td>Video</td>
        </tr>
        <tr>
            <td>Text</td>
            <td>❌</td>
        </tr>
        <tr>
            <td>IFrame</td>
            <td>❌</td>
        </tr>
        <!-- RENDERING -->
        <tr>
            <td><strong>Rendering</strong></td>
            <td>🟨</td>
            <td>🟨</td>
            <td>🟨</td>
            <td>🟨</td>
        </tr>
        <tr>
            <td>Color objects</td>
            <td>✅</td>
            <td>✅</td>
            <td>✅</td>
            <td>✅</td>
        </tr>
        <tr>
            <td>2D heatmap (≃ gradient texture)</td>
            <td rowspan="2">Must use shaders</td>
            <td rowspan="2">Must use shaders / dynamic textures</td>
            <td rowspan="2">Shaders and/or <a href="https://cesium.com/learn/ion-sdk/ref-doc/Material.html">Cesium.Material</a> (<a href="https://sandcastle.cesium.com/?src=Globe%20Materials.html&label=All">example</a>)</td>
            <td rowspan="2">Heatmap <a href="https://www.itwinjs.org/reference/core-frontend/views/decorator/">decorator</a> (<a href="https://www.itwinjs.org/sandboxes/iTwinPlatform/Heatmap Decorator/">example</a>) / Thematic display (<a href="https://www.itwinjs.org/sandboxes/iTwinPlatform/Thematic Display/">example</a>)</td>
        </tr>
        <tr>
            <td>3D heatmap (≃ volumetric rendering)</td>
        </tr>
        <tr>
            <td>3D model</td>
            <td colspan="2">Create + import from <a href="https://threejs.org/manual/#en/loading-3d-models">multiple format</a> (mainly glTF but there is a lot of <a href="https://github.khronos.org/glTF-Project-Explorer/">converter</a> “X to glTF”)</td>
            <td>Mainly 3D tiles but can import from a few other formats (including glTF (<a href="https://cesium.com/learn/3d-tiling/ion-tile-3d-models/#supported-formats">list</a>))</td>
            <td>iModels (Bentley’s proprietary format).</td>
        </tr>
        <tr>
            <td>2D interfaces in the 3D model (use case: AR/VR)</tr>
            <td>Can be partially done using <a href="https://threejs.org/docs/#examples/en/renderers/CSS3DRenderer">CSS3DRenderer</a>.</td>
            <td>Part of Babylon.GUI (<a href="https://tinyurl.com/yxtmjaym">example</a>)
            <td>Can use HTML / CSS as overlay with no support for user interaction.</td>
            <td></td>
        </tr>
        <!-- INTERACTION -->
        <tr>
            <td><strong>Support for interaction with 3D model</strong></td>
            <td>🟨</td>
            <td>🟨</td>
            <td>🟨</td>
            <td>✅</td>
        </tr>
        <tr>
            <td>Retrieve object selected by user</td>
            <td>✅</td>
            <td>✅</td>
            <td>✅</td>
            <td>✅</td>
        </tr>
        <tr>
            <td>Retrieve object properties</td>
            <td colspan="3">❌ Must be implemented separately.</td>
            <td>✅ Within the iModel format. Properties are already linked to the 3D model.</td>
        </tr>
        <!-- STORAGE -->
        <tr>
            <td><strong>Store and manage 3D models and associated data</strong></td>
            <td>❌</td>
            <td>❌</td>
            <td>❌</td>
            <td>✅</td>
        </tr>
        <tr>
            <td>Object properties and metadata</td>
            <td colspan="3">❌ Must be implemented separately. Preferably using an object database</td>
            <td>✅ Within the iModel format.</td>
        </tr>
        <tr>
            <td>3D model storage</td>
            <td colspan="3">❌ Must be implemented separately. Cloud object storage (AWS, Azure blob, ... (⚠️ not open source)) ?</td>
            <td>✅ iTwin platform.</td>
        </tr>
        <!-- CONCLUSION -->
        <tr>
            <td><strong>Conclusion</strong></td>
            <td>Low level library that offers more control over the application you want to create as the cost of a higher development cost.</td>
            <td>Great solution for 3D real-time rendering with a lot of built-in features but not specifically designed for AEC applications, with a smaller comunity and extensions than Three.js.</td>
            <td>Great to place virtual building on a virtual globe representing its real-world location and use another solution to handle the digital twin indoor (Three / Babylon / …).</td>
            <td>iTwin.js itself provides components to create the frond-end but it’s Bentley’s iTwin solution that handle the backend (3D model storage, lifecycle of elements, …) and this part is not open-source.</td>
        </tr>
    </tbody>
</table>