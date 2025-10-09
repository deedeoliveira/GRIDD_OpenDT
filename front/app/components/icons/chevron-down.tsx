export const ChevronDown = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={props.width || "32"} height={props.height || "32"} viewBox="0 0 24 24">
        {/* Icon from Material Design Icons by Pictogrammers - https://github.com/Templarian/MaterialDesign/blob/master/LICENSE */}
        <path fill={props.fill || "#888888"} d="M7.41 8.58L12 13.17l4.59-4.59L18 10l-6 6l-6-6z"/>
    </svg>
);