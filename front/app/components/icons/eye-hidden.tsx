export const EyeHidden = (props: React.SVGProps<SVGSVGElement>) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={props.width || "32"} height={props.height || "32"} viewBox="0 0 24 24" aria-hidden="true">
        {/* Icon from Material Design Icons by Pictogrammers - https://github.com/Templarian/MaterialDesign/blob/master/LICENSE */}
        <path fill={props.fill || "currentColor"} d="M2.39 1.73L1.11 3l3.01 3.01A12.34 12.34 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5c1.61 0 3.14-.32 4.53-.9L20.73 22L22 20.73L2.39 1.73M12 17.5A5.5 5.5 0 0 1 6.5 12c0-.56.09-1.1.24-1.61l1.75 1.75A3.5 3.5 0 0 0 11.86 15.5l1.75 1.75c-.51.16-1.05.25-1.61.25m0-11c-1.61 0-3.14.32-4.53.9L9.2 9.13A3.5 3.5 0 0 1 14.87 14.8l1.73 1.73A9.76 9.76 0 0 0 20.82 12A9.82 9.82 0 0 0 12 6.5Z"/>
    </svg>
);
